const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { favorites: {}, collected: {}, priceHistory: {} }; }
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ── Cards search ──────────────────────────────────────────────────
app.get('/api/cards', async (req, res) => {
  try {
    const { set, page = 1, pageSize = 20, search = '' } = req.query;
    const setFilter = set && set !== 'all' ? ` set.id:${set}` : '';
    const searchFilter = search ? ` name:${search}*` : '';
    const q = encodeURIComponent(`rarity:"Illustration Rare"${setFilter}${searchFilter}`);
    const url = `https://api.pokemontcg.io/v2/cards?q=${q}&page=${page}&pageSize=${pageSize}&orderBy=set.releaseDate,number`;
    const response = await fetch(url, { headers: { 'User-Agent': 'pokemon-ir-app/1.0' } });
    const data = await response.json();

    // Record price history for favorites
    const appData = loadData();
    if (data.data) {
      const today = new Date().toISOString().split('T')[0];
      data.data.forEach(card => {
        const price = getTrendPrice(card);
        if (price && appData.favorites[card.id]) {
          if (!appData.priceHistory[card.id]) appData.priceHistory[card.id] = [];
          const hist = appData.priceHistory[card.id];
          if (!hist.find(h => h.date === today)) {
            hist.push({ date: today, price });
            // Keep last 365 days
            if (hist.length > 365) hist.shift();
          }
        }
      });
      saveData(appData);
    }

    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Single card ───────────────────────────────────────────────────
app.get('/api/cards/:id', async (req, res) => {
  try {
    const url = `https://api.pokemontcg.io/v2/cards/${req.params.id}`;
    const response = await fetch(url, { headers: { 'User-Agent': 'pokemon-ir-app/1.0' } });
    const data = await response.json();

    // Record price history
    const card = data.data;
    if (card) {
      const appData = loadData();
      const today = new Date().toISOString().split('T')[0];
      const price = getTrendPrice(card);
      if (price) {
        if (!appData.priceHistory[card.id]) appData.priceHistory[card.id] = [];
        const hist = appData.priceHistory[card.id];
        if (!hist.find(h => h.date === today)) {
          hist.push({ date: today, price });
          if (hist.length > 365) hist.shift();
        }
        saveData(appData);
      }
    }
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── User data ─────────────────────────────────────────────────────
app.get('/api/userdata', (req, res) => res.json(loadData()));

app.post('/api/userdata', (req, res) => {
  try { saveData(req.body); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Price alerts ──────────────────────────────────────────────────
app.get('/api/alerts', (req, res) => {
  const appData = loadData();
  const alerts = [];
  Object.entries(appData.priceHistory || {}).forEach(([cardId, history]) => {
    if (history.length < 2) return;
    const card = appData.favorites[cardId];
    if (!card) return;
    const prices = history.map(h => h.price);
    const lifetimeAvg = prices.reduce((a, b) => a + b, 0) / prices.length;
    const current = prices[prices.length - 1];
    if (current < lifetimeAvg * 0.95) { // 5% below lifetime avg
      alerts.push({
        cardId,
        cardName: card.name,
        cardImage: card.images?.small,
        currentPrice: current,
        lifetimeAvg: lifetimeAvg,
        dropPct: Math.round((1 - current / lifetimeAvg) * 100),
        cmUrl: card.cardmarket?.url
      });
    }
  });
  res.json(alerts);
});

function getTrendPrice(card) {
  return card?.cardmarket?.prices?.trendPrice
    ?? card?.cardmarket?.prices?.avg30
    ?? card?.tcgplayer?.prices?.holofoil?.market
    ?? card?.tcgplayer?.prices?.normal?.market
    ?? null;
}

app.listen(PORT, () => {
  console.log(`\n🎴 Pokémon IR Browser op http://localhost:${PORT}\n`);
});
