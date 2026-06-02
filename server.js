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
  await UserData.findOneAndUpdate({ key: 'main' }, { $set: fields }, { upsert: true, new: true });
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

const HEADERS = { 'User-Agent': 'pokemon-ir-app/7.0' };

// ── Sets cache ────────────────────────────────────────────────────
let setsCache = null;
let setsCacheTime = 0;
const SETS_CACHE_TTL = 6 * 60 * 60 * 1000;

// Promo sets that contain Illustration Rare cards but list them as "Black Star Promo"
// We include these explicitly so they always appear
const KNOWN_PROMO_SETS = [
  { id: 'svp',   name: 'Scarlet & Violet Black Star Promos', series: 'Scarlet & Violet', isPromo: true },
  { id: 'swshp', name: 'Sword & Shield Black Star Promos',   series: 'Sword & Shield',   isPromo: true },
];

async function checkSetForIR(setId, rarity = 'Illustration Rare') {
  const q = encodeURIComponent(`set.id:${setId} rarity:"${rarity}"`);
  const r = await fetch(`https://api.pokemontcg.io/v2/cards?q=${q}&pageSize=1`, { headers: HEADERS });
  const d = await r.json();
  return d.totalCount || 0;
}

async function fetchAllIRSets() {
  const now = Date.now();
  if (setsCache && now - setsCacheTime < SETS_CACHE_TTL) return setsCache;
  console.log('[sets] Discovering all sets with Illustration Rares…');

  try {
    // Fetch all sets from API (no date filter)
    const setsRes = await fetch('https://api.pokemontcg.io/v2/sets?orderBy=-releaseDate&pageSize=250', { headers: HEADERS });
    const setsData = await setsRes.json();
    const allSets = setsData.data || [];

    const setsWithIR = [];
    const BATCH = 5;

    for (let i = 0; i < allSets.length; i += BATCH) {
      const batch = allSets.slice(i, i + BATCH);
      await Promise.all(batch.map(async set => {
        try {
          // Check standard "Illustration Rare" rarity
          const count = await checkSetForIR(set.id, 'Illustration Rare');
          if (count > 0) {
            setsWithIR.push({
              id: set.id, name: set.name,
              releaseDate: set.releaseDate,
              total: count,
              series: set.series,
              isPromo: false
            });
          }
        } catch {}
      }));
      if (i + BATCH < allSets.length) await new Promise(r => setTimeout(r, 250));
    }

    // Also check known promo sets with "Black Star Promo" rarity
    for (const promoSet of KNOWN_PROMO_SETS) {
      try {
        const count = await checkSetForIR(promoSet.id, 'Illustration Rare');
        const countBSP = await checkSetForIR(promoSet.id, 'Black Star Promo');
        const total = count + countBSP;
        if (total > 0) {
          // Check if it's already added (some promo sets do list as IR)
          const existing = setsWithIR.find(s => s.id === promoSet.id);
          if (existing) {
            existing.total = total;
            existing.isPromo = true;
          } else {
            setsWithIR.push({ ...promoSet, total, releaseDate: '2022-09-01' });
          }
        }
      } catch {}
    }

    setsWithIR.sort((a, b) => {
      // Promos last within their series
      if (a.isPromo && !b.isPromo) return 1;
      if (!a.isPromo && b.isPromo) return -1;
      return new Date(b.releaseDate) - new Date(a.releaseDate);
    });

    console.log(`[sets] Found ${setsWithIR.length} sets with IR/promo IR cards`);
    setsCache = setsWithIR;
    setsCacheTime = now;
    return setsWithIR;
  } catch (e) {
    console.error('[sets]', e.message);
    return setsCache || [];
  }
}

// ── Cards route — supports both IR and promo IR ───────────────────
app.get('/api/cards', async (req, res) => {
  try {
    const { set, page = 1, pageSize = 20, search = '' } = req.query;
    const setFilter = set && set !== 'all' ? ` set.id:${set}` : '';
    const searchFilter = search ? ` name:${search}*` : '';

    // Detect if this is a promo set (needs Black Star Promo query too)
    const isPromoSet = set && KNOWN_PROMO_SETS.some(p => p.id === set);

    let allCards = [];
    let totalCount = 0;

    if (isPromoSet) {
      // Fetch both IR and Black Star Promo rarity for promo sets
      const [irRes, bspRes] = await Promise.all([
        fetch(`https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(`rarity:"Illustration Rare"${setFilter}${searchFilter}`)}&pageSize=250`, { headers: HEADERS }),
        fetch(`https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(`rarity:"Black Star Promo"${setFilter}${searchFilter}`)}&pageSize=250`, { headers: HEADERS }),
      ]);
      const [irData, bspData] = await Promise.all([irRes.json(), bspRes.json()]);

      // Merge and deduplicate
      const merged = [...(irData.data || []), ...(bspData.data || [])];
      const seen = new Set();
      allCards = merged.filter(c => { if (seen.has(c.id)) return false; seen.add(c.id); return true; });
      allCards.sort((a, b) => parseInt(a.number) - parseInt(b.number));
      totalCount = allCards.length;

      // Manual pagination
      const start = (page - 1) * pageSize;
      allCards = allCards.slice(start, start + parseInt(pageSize));
    } else {
      // Normal IR query
      const q = encodeURIComponent(`rarity:"Illustration Rare"${setFilter}${searchFilter}`);
      const url = `https://api.pokemontcg.io/v2/cards?q=${q}&page=${page}&pageSize=${pageSize}&orderBy=-set.releaseDate,number`;
      const response = await fetch(url, { headers: HEADERS });
      const data = await response.json();
      allCards = data.data || [];
      totalCount = data.totalCount || 0;
    }

    // Update cardCache and priceHistory
    const doc = await getData();
    const today = new Date().toISOString().split('T')[0];
    const ph = { ...(doc.priceHistory || {}) };
    const cc = { ...(doc.cardCache || {}) };
    let changed = false;

    allCards.forEach(card => {
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

    res.json({ data: allCards, totalCount, page: parseInt(page), pageSize: parseInt(pageSize) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Single card ───────────────────────────────────────────────────
app.get('/api/cards/:id', async (req, res) => {
  try {
    const r = await fetch(`https://api.pokemontcg.io/v2/cards/${req.params.id}`, { headers: HEADERS });
    const data = await r.json();
    const card = data.data;
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
    res.json(data);
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
      favorites:    doc.favorites    || {},
      collected:    doc.collected    || {},
      cardCache:    doc.cardCache    || {},
      priceHistory: doc.priceHistory || {}
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
      const lifetimeAvg = prices.reduce((a, b) => a + b, 0) / prices.length;
      const current = prices[prices.length - 1];
      if (current < lifetimeAvg * 0.95) {
        alerts.push({
          cardId, cardName: card.name, cardImage: card.images?.small,
          currentPrice: current, lifetimeAvg,
          dropPct: Math.round((1 - current / lifetimeAvg) * 100),
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
