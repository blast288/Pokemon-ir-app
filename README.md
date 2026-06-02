# 🎴 Pokémon Illustration Rare Browser

Een lokale webapp om Pokémon Illustration Rare kaarten te bladeren, prijzen te bekijken en een wishlist bij te houden.

## Vereisten

- [Node.js](https://nodejs.org) (versie 18 of hoger)

## Installatie & starten

1. **Pak de map uit** en open een terminal in de map `pokemon-ir-app`

2. **Installeer dependencies:**
   ```bash
   npm install
   ```

3. **Start de app:**
   ```bash
   npm start
   ```

4. **Open in browser:**
   ```
   http://localhost:3000
   ```

## Functies

- 🔍 Blader door alle Illustration Rares (Lost Origin t/m Prismatic Evolutions)
- 🗂️ Filter op specifieke set of bekijk alle sets tegelijk
- 💰 Marktprijzen (30-daags gemiddelde) via Pokémon TCG API (Cardmarket/TCGPlayer)
- ♡ Voeg kaarten toe aan je wishlist
- ✓ Vink kaarten af als ze gecollect zijn
- 💶 Wishlist-totaal met opgesplitste bedragen
- 💾 Wishlist & collectie worden lokaal opgeslagen in `data.json`

## Opmerking over prijzen

Prijzen komen rechtstreeks uit de Pokémon TCG API, die Cardmarket en TCGPlayer data bevat. Ze worden actueel opgehaald telkens je een kaartdetail opent.
