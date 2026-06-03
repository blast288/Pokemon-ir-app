const express = require('express');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const mongoose = require('mongoose');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/pokemon-ir';

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── MongoDB ───────────────────────────────────────────────────────
const userDataSchema = new mongoose.Schema({
  key:          { type: String, default: 'main', unique: true },
  favorites:    { type: mongoose.Schema.Types.Mixed, default: {} },
  collected:    { type: mongoose.Schema.Types.Mixed, default: {} },
  cardCache:    { type: mongoose.Schema.Types.Mixed, default: {} },
  priceHistory: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

const UserData = mongoose.model('UserData', userDataSchema);

async function getData() {
  let doc = await UserData.findOne({ key: 'main' });
  if (!doc) doc = await UserData.create({ key: 'main' });
  return doc;
}
async function patchData(fields) {
  await UserData.findOneAndUpdate(
    { key: 'main' }, { $set: fields }, { upsert: true, new: true }
  );
}

// ── Helpers ───────────────────────────────────────────────────────
function getPriceInfo(card) {
  const cm = card?.cardmarket?.prices;
  if (cm) {
    const p = cm.trendPrice ?? cm.avg30 ?? cm.averageSellPrice ?? null;
    if (p != null) return { price: p, source: 'cardmarket' };
  }
  const tcg = card?.tcgplayer?.prices;
  if (tcg) {
    const v = tcg.holofoil ?? tcg.reverseHolofoil ?? tcg.normal ?? Object.values(tcg)[0];
    const p = v?.market ?? v?.mid ?? null;
    if (p != null) return { price: p, source: 'tcgplayer' };
  }
  return { price: null, source: null };
}

function cacheCard(card) {
  return {
    id: card.id, name: card.name, number: card.number,
    set: { id: card.set?.id, name: card.set?.name },
    images: card.images, artist: card.artist,
    cardmarket: card.cardmarket, tcgplayer: card.tcgplayer,
    rarity: card.rarity
  };
}

const H = { 'User-Agent': 'pokemon-ir-app/9.0' };

// ── Sets cache ────────────────────────────────────────────────────
let setsCache = null;
let setsCacheTime = 0;
const SETS_CACHE_TTL = 6 * 60 * 60 * 1000;

// All rarities that can be Illustration Rare in disguise
const IR_RARITIES = ['Illustration Rare'];
// Rarities used by promo sets for their IR-style cards
const PROMO_IR_RARITIES = ['Promo', 'Black Star Promo', 'Illustration Rare'];

async function countCardsInSet(setId, rarity) {
  try {
    const q = encodeURIComponent(`set.id:${setId} rarity:"${rarity}"`);
    const r = await fetch(`https://api.pokemontcg.io/v2/cards?q=${q}&pageSize=1`, { headers: H });
    const d = await r.json();
    return d.totalCount || 0;
  } catch { return 0; }
}

async function fetchAllIRSets() {
  const now = Date.now();
  if (setsCache && now - setsCacheTime < SETS_CACHE_TTL) return setsCache;
  console.log('[sets] Discovering all sets with IR cards…');

  try {
    const setsRes = await fetch('https://api.pokemontcg.io/v2/sets?orderBy=-releaseDate&pageSize=250', { headers: H });
    const setsData = await setsRes.json();
    const allSets = setsData.data || [];

    const setsWithIR = [];
    const BATCH = 5;

    for (let i = 0; i < allSets.length; i += BATCH) {
      const batch = allSets.slice(i, i + BATCH);
      await Promise.all(batch.map(async set => {
        try {
          const isPromo = set.name.toLowerCase().includes('promo') ||
                          set.id.endsWith('p') ||
                          set.series?.toLowerCase().includes('promo');

          if (isPromo) {
            // For promo sets: check all possible promo IR rarities
            let total = 0;
            for (const rarity of PROMO_IR_RARITIES) {
              total += await countCardsInSet(set.id, rarity);
            }
            if (total > 0) {
              setsWithIR.push({
                id: set.id, name: set.name, releaseDate: set.releaseDate,
                total, series: set.series, isPromo: true
              });
            }
          } else {
            // For regular sets: check "Illustration Rare" only
            const count = await countCardsInSet(set.id, 'Illustration Rare');
            if (count > 0) {
              setsWithIR.push({
                id: set.id, name: set.name, releaseDate: set.releaseDate,
                total: count, series: set.series, isPromo: false
              });
            }
          }
        } catch {}
      }));
      if (i + BATCH < allSets.length) await new Promise(r => setTimeout(r, 250));
    }

    setsWithIR.sort((a, b) => {
      if (a.isPromo && !b.isPromo) return 1;
      if (!a.isPromo && b.isPromo) return -1;
      return new Date(b.releaseDate) - new Date(a.releaseDate);
    });

    console.log(`[sets] Found ${setsWithIR.length} sets (including promo sets)`);
    setsCache = setsWithIR;
    setsCacheTime = now;
    return setsWithIR;
  } catch (e) {
    console.error('[sets]', e.message);
    return setsCache || [];
  }
}

// ── Cards route ───────────────────────────────────────────────────
app.get('/api/cards', async (req, res) => {
  try {
    const { set, page = 1, pageSize = 20, search = '' } = req.query;
    const setFilter = set && set !== 'all' ? ` set.id:${set}` : '';
    const searchFilter = search ? ` name:${search}*` : '';

    // Detect promo set
    const sets = setsCache || [];
    const setInfo = sets.find(s => s.id === set);
    const isPromoSet = setInfo?.isPromo ||
      (set && set !== 'all' && (set.endsWith('p') || set === 'mep' || set === 'svp' || set === 'swshp'));

    let cards = [];
    let totalCount = 0;

    if (isPromoSet) {
      // Fetch all promo IR rarities in parallel
      const results = await Promise.all(
        PROMO_IR_RARITIES.map(rarity =>
          fetch(
            `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(`rarity:"${rarity}"${setFilter}${searchFilter}`)}&pageSize=250`,
            { headers: H }
          ).then(r => r.json()).catch(() => ({ data: [] }))
        )
      );
      // Merge and deduplicate by card ID
      const seen = new Set();
      const merged = results.flatMap(d => d.data || []).filter(c => {
        if (seen.has(c.id)) return false;
        seen.add(c.id); return true;
      });
      merged.sort((a, b) => parseInt(a.number) - parseInt(b.number));
      totalCount = merged.length;
      const start = (parseInt(page) - 1) * parseInt(pageSize);
      cards = merged.slice(start, start + parseInt(pageSize));
    } else if (set === 'all') {
      // All sets: only query "Illustration Rare" (promos are handled per-set)
      const q = encodeURIComponent(`rarity:"Illustration Rare"${searchFilter}`);
      const url = `https://api.pokemontcg.io/v2/cards?q=${q}&page=${page}&pageSize=${pageSize}&orderBy=-set.releaseDate,number`;
      const d = await fetch(url, { headers: H }).then(r => r.json());
      cards = d.data || [];
      totalCount = d.totalCount || 0;
    } else {
      // Specific regular set
      const q = encodeURIComponent(`rarity:"Illustration Rare"${setFilter}${searchFilter}`);
      const url = `https://api.pokemontcg.io/v2/cards?q=${q}&page=${page}&pageSize=${pageSize}&orderBy=number`;
      const d = await fetch(url, { headers: H }).then(r => r.json());
      cards = d.data || [];
      totalCount = d.totalCount || 0;
    }

    // Update cache + price history
    const doc = await getData();
    const today = new Date().toISOString().split('T')[0];
    const ph = { ...(doc.priceHistory || {}) };
    const cc = { ...(doc.cardCache || {}) };
    let changed = false;

    cards.forEach(card => {
      cc[card.id] = cacheCard(card);
      const { price } = getPriceInfo(card);
      if (price && doc.favorites[card.id]) {
        if (!ph[card.id]) ph[card.id] = [];
        if (!ph[card.id].find(h => h.date === today)) {
          ph[card.id].push({ date: today, price });
          if (ph[card.id].length > 365) ph[card.id].shift();
          changed = true;
        }
      }
    });
    if (changed) await patchData({ priceHistory: ph, cardCache: cc });
    else await patchData({ cardCache: cc });

    res.json({ data: cards, totalCount, page: parseInt(page), pageSize: parseInt(pageSize) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Single card ───────────────────────────────────────────────────
app.get('/api/cards/:id', async (req, res) => {
  try {
    const d = await fetch(`https://api.pokemontcg.io/v2/cards/${req.params.id}`, { headers: H }).then(r => r.json());
    const card = d.data;
    if (card) {
      const doc = await getData();
      const today = new Date().toISOString().split('T')[0];
      const { price } = getPriceInfo(card);
      const ph = { ...(doc.priceHistory || {}) };
      const cc = { ...(doc.cardCache || {}) };
      cc[card.id] = cacheCard(card);
      if (price) {
        if (!ph[card.id]) ph[card.id] = [];
        if (!ph[card.id].find(h => h.date === today)) {
          ph[card.id].push({ date: today, price });
          if (ph[card.id].length > 365) ph[card.id].shift();
        }
      }
      await patchData({ priceHistory: ph, cardCache: cc });
    }
    res.json(d);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Sets ──────────────────────────────────────────────────────────
app.get('/api/sets', async (req, res) => {
  try { res.json(await fetchAllIRSets()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── User data ─────────────────────────────────────────────────────
app.get('/api/userdata', async (req, res) => {
  try {
    const doc = await getData();
    res.json({
      favorites: doc.favorites || {}, collected: doc.collected || {},
      cardCache: doc.cardCache || {}, priceHistory: doc.priceHistory || {}
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/userdata/favorites', async (req, res) => {
  try { await patchData({ favorites: req.body }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/userdata/collected', async (req, res) => {
  try { await patchData({ collected: req.body }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Alerts ────────────────────────────────────────────────────────
app.get('/api/alerts', async (req, res) => {
  try {
    const doc = await getData();
    const alerts = [];
    Object.entries(doc.priceHistory || {}).forEach(([cardId, history]) => {
      if (history.length < 2) return;
      const card = doc.favorites[cardId];
      if (!card) return;
      const prices = history.map(h => h.price);
      const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
      const current = prices[prices.length - 1];
      if (current < avg * 0.95) {
        alerts.push({
          cardId, cardName: card.name, cardImage: card.images?.small,
          currentPrice: current, lifetimeAvg: avg,
          dropPct: Math.round((1 - current / avg) * 100),
          cmUrl: card.cardmarket?.url
        });
      }
    });
    res.json(alerts);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Start ─────────────────────────────────────────────────────────
mongoose.connect(MONGO_URI)
  .then(() => {
    console.log('✅ MongoDB verbonden');
    app.listen(PORT, () => console.log(`\n🎴 Pokémon IR Browser op http://localhost:${PORT}\n`));
    fetchAllIRSets().catch(console.error);
  })
  .catch(err => {
    console.error('❌ MongoDB verbinding mislukt:', err.message);
    process.exit(1);
  });
