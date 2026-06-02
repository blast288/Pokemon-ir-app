const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Load/save local data (favorites + collected)
function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { favorites: {}, collected: {} }; }
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ── Proxy: search cards ───────────────────────────────────────────
app.get('/api/cards', async (req, res) => {
  try {
    const { set, page = 1, pageSize = 20 } = req.query;
    const setFilter = set && set !== 'all' ? ` set.id:${set}` : '';
    const q = encodeURIComponent(`rarity:"Illustration Rare"${setFilter}`);
    const url = `https://api.pokemontcg.io/v2/cards?q=${q}&page=${page}&pageSize=${pageSize}&orderBy=set.releaseDate,number`;
    const response = await fetch(url, { headers: { 'User-Agent': 'pokemon-ir-app/1.0' } });
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Proxy: single card detail ─────────────────────────────────────
app.get('/api/cards/:id', async (req, res) => {
  try {
    const url = `https://api.pokemontcg.io/v2/cards/${req.params.id}`;
    const response = await fetch(url, { headers: { 'User-Agent': 'pokemon-ir-app/1.0' } });
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Local data: get favorites + collected ─────────────────────────
app.get('/api/userdata', (req, res) => {
  res.json(loadData());
});

// ── Local data: save favorites + collected ────────────────────────
app.post('/api/userdata', (req, res) => {
  try {
    saveData(req.body);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🎴 Pokémon IR Browser draait op http://localhost:${PORT}\n`);
});
