# ⚡ Pokémon IR Collection — v4

Illustration Rare browser met MongoDB voor permanente opslag.

## Vereisten
- [Node.js](https://nodejs.org) v18+
- MongoDB Atlas account (gratis)

---

## Stap 1: MongoDB Atlas instellen

1. Ga naar [mongodb.com/cloud/atlas](https://www.mongodb.com/cloud/atlas)
2. Klik **Try Free** → maak een account
3. Kies **M0 Free** tier → kies een regio dicht bij jou (bv. Frankfurt)
4. Klik **Create Deployment**
5. Maak een gebruiker aan: kies een gebruikersnaam + wachtwoord (onthoud deze!)
6. Bij **Network Access** → klik **Add IP Address** → kies **Allow Access from Anywhere**
7. Ga naar **Database** → klik **Connect** → kies **Drivers**
8. Kopieer de connection string, die ziet er zo uit:
   ```
   mongodb+srv://gebruikersnaam:wachtwoord@cluster0.xxxxx.mongodb.net/pokemon-ir
   ```
   Vervang `<password>` met jouw wachtwoord en voeg `/pokemon-ir` toe aan het einde.

---

## Stap 2: Lokaal draaien

```bash
# Installeer dependencies
npm install

# Stel je MongoDB URI in (tijdelijk, voor testen)
# Windows:
set MONGO_URI=mongodb+srv://...

# Mac/Linux:
export MONGO_URI=mongodb+srv://...

# Start de app
npm start
```

Open `http://localhost:3000`

---

## Stap 3: Deployen op Render

1. Upload de bestanden naar GitHub (zoals eerder)
2. Ga naar [render.com](https://render.com) → open je Web Service
3. Ga naar **Environment** → klik **Add Environment Variable**
   - Key: `MONGO_URI`
   - Value: jouw MongoDB connection string
4. Klik **Save Changes** → Render herstart automatisch

Je data blijft nu bewaard bij elke update! 🎉

---

## Data migreren van oude versie

Als je data hebt in een oude `data.json`, kopieer dan de inhoud en stuur die éénmalig via:

```bash
curl -X POST http://localhost:3000/api/userdata \
  -H "Content-Type: application/json" \
  -d @data.json
```
