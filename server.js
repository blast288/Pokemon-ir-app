const express = require('express');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const mongoose = require('mongoose');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/pokemon-ir';

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── MongoDB schema ────────────────────────────────────────────────
const userDataSchema = new mongoose.Schema({
  key: { type: String, default: 'main', unique: true },
  favorites: { type: mongoose.Schema.Types.Mixed, default: {} },
  collected: { type: mongoose.Schema.Types.Mixed, default: {} },
  // cardCache: full card objects for ALL cards user has interacted with
  // This allows the Verzameld tab to show cards regardless of current page
  cardCache: { type: mongoose.Schema.Types.Mixed, default: {} },
  priceHistory: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

const UserData = mongoose.model('UserData', userDataSchema);

async function getData() {
  let doc = await UserData.findOne({ key: 'main' });
  if (!doc) doc = await UserData.create({ key: 'main' });
  return doc;
}

// Partial update — only update fields that are provided
async function patchData(fields) {
  await UserData.findOneAndUpdate(
    { key: 'main' },
    { $set: fields },
    { upsert: true, new: true }
  );
}

// ── Price helpers ─────────────────────────────────────────────────
function getTrendPrice(card) {
  const cm = card?.cardmarket?.prices;
  // Only use cardmarket if it actually has real price values
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

// ── Sets cache ────────────────────────────────────────────────────
let setsCache = null;
let setsCacheTime = 0;
const SETS_CACHE_TTL = 6 * 60 * 60 * 1000;

async function fetchAllIRSets() {
  const now = Date.now();
  if (setsCache && now - setsCacheTime < SETS_CACHE_TTL) return setsCache;
  console.log('[sets] Discovering all sets with Illustration Rares…');
  try {
    const setsRes = await fetch('https://api.pokemontcg.io/v2/sets?orderBy=-releaseDate&pageSize=250', {
      headers: { 'User-Agent': 'pokemon-ir-app/5.0' }
    });
    const setsData = await setsRes.json();
    const allSets = (setsData.data || []).filter(s => new Date(s.releaseDate) >= new Date('2022-09-01'));
    const setsWithIR = [];
    const BATCH = 5;
    for (let i = 0; i < allSets.length; i += BATCH) {
      const batch = allSets.slice(i, i + BATCH);
      await Promise.all(batch.map(async set => {
        try {
          const r = await fetch(`https://api.pokemontcg.io/v2/cards?q=set.id:${set.id}+rarity:"Illustration Rare"&pageSize=1`, {
            headers: { 'User-Agent': 'pokemon-ir-app/5.0' }
          });
          const d = await r.json();
          if (d.totalCount > 0) setsWithIR.push({ id: set.id, name: set.name, releaseDate: set.releaseDate, total: d.totalCount, series: set.series });
        } catch {}
      }));
      if (i + BATCH < allSets.length) await new Promise(r => setTimeout(r, 300));
    }
    setsWithIR.sort((a, b) => new Date(b.releaseDate) - new Date(a.releaseDate));
    console.log(`[sets] Found ${setsWithIR.length} sets with IR cards`);
    setsCache = setsWithIR;
    setsCacheTime = now;
    return setsWithIR;
  } catch (e) {
    console.error('[sets]', e.message);
    return setsCache || [];
  }
}

// ── Routes ────────────────────────────────────────────────────────
app.get('/api/sets', async (req, res) => {
  try { res.json(await fetchAllIRSets()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/cards', async (req, res) => {
  try {
    const { set, page = 1, pageSize = 20, search = '' } = req.query;
    const setFilter = set && set !== 'all' ? ` set.id:${set}` : '';
    const searchFilter = search ? ` name:${search}*` : '';
    const q = encodeURIComponent(`rarity:"Illustration Rare"${setFilter}${searchFilter}`);
    const url = `https://api.pokemontcg.io/v2/cards?q=${q}&page=${page}&pageSize=${pageSize}&orderBy=-set.releaseDate,number`;
    const response = await fetch(url, { headers: { 'User-Agent': 'pokemon-ir-app/5.0' } });
    const data = await response.json();

    if (data.data) {
      const doc = await getData();
      const today = new Date().toISOString().split('T')[0];
      const ph = { ...(doc.priceHistory || {}) };
      const cc = { ...(doc.cardCache || {}) };
      let changed = false;

      data.data.forEach(card => {
        // Cache every card we see (stripped down to save space)
        cc[card.id] = {
          id: card.id, name: card.name, number: card.number,
          set: { id: card.set?.id, name: card.set?.name },
          images: card.images, artist: card.artist,
          cardmarket: card.cardmarket, tcgplayer: card.tcgplayer,
          rarity: card.rarity
        };
        // Record price history for favorited cards
        const { price } = getTrendPrice(card);
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
    }
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/cards/:id', async (req, res) => {
  try {
    const r = await fetch(`https://api.pokemontcg.io/v2/cards/${req.params.id}`, {
      headers: { 'User-Agent': 'pokemon-ir-app/5.0' }
    });
    const data = await r.json();
    const card = data.data;
    if (card) {
      const doc = await getData();
      const today = new Date().toISOString().split('T')[0];
      const { price } = getTrendPrice(card);
      const ph = { ...(doc.priceHistory || {}) };
      const cc = { ...(doc.cardCache || {}) };
      cc[card.id] = {
        id: card.id, name: card.name, number: card.number,
        set: { id: card.set?.id, name: card.set?.name },
        images: card.images, artist: card.artist,
        cardmarket: card.cardmarket, tcgplayer: card.tcgplayer,
        rarity: card.rarity
      };
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

app.get('/api/userdata', async (req, res) => {
  try {
    const doc = await getData();
    res.json({
      favorites: doc.favorites || {},
      collected: doc.collected || {},
      cardCache: doc.cardCache || {},
      priceHistory: doc.priceHistory || {}
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Granular save endpoints — avoids overwriting unrelated fields
app.post('/api/userdata/favorites', async (req, res) => {
  try { await patchData({ favorites: req.body }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/userdata/collected', async (req, res) => {
  try { await patchData({ collected: req.body }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/userdata', async (req, res) => {
  try {
    const { favorites, collected, priceHistory, cardCache } = req.body;
    await patchData({
      ...(favorites !== undefined && { favorites }),
      ...(collected !== undefined && { collected }),
      ...(priceHistory !== undefined && { priceHistory }),
      ...(cardCache !== undefined && { cardCache }),
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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
        alerts.push({ cardId, cardName: card.name, cardImage: card.images?.small, currentPrice: current, lifetimeAvg, dropPct: Math.round((1 - current / lifetimeAvg) * 100), cmUrl: card.cardmarket?.url });
      }
    });
    res.json(alerts);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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
