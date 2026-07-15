# Symbol Window Duel

Two-player real-time online game. Players alternate placing X, Y, or Z into a shared sequence.

- **P1 wins** the instant any 5-symbol window exactly repeats another 5-symbol window.
- **P2 wins** the instant any 3-symbol window has occurred 4 separate times.
- **Draw** if a single move triggers both at once.

Includes matchmaking (auto-pairs two waiting players) and Glicko-2 ratings.

## Run locally

```bash
npm install
npm start
```

Visit `http://localhost:3000`. Open a second tab/incognito window to test matchmaking against yourself.

## Deploy (free)

1. Push this folder to a new GitHub repo.
2. Go to [render.com](https://render.com), create a **Web Service**, connect your repo.
3. Build command: `npm install` — Start command: `npm start`.
4. Render gives you a free `yourapp.onrender.com` URL. Done — no domain purchase needed.

Later, if you want a custom domain, buy one from any registrar (~$5–10/yr) and add it under
your Render service's **Settings → Custom Domain**.

## Project structure

```
server.js       Express + Socket.IO server (matchmaking, rooms, moves)
gameLogic.js    Win-condition rules — single source of truth
rating.js       Glicko-2 rating implementation (no external deps)
public/         Frontend (single HTML file, vanilla JS + Socket.IO client)
```

## Notes

- Ratings and rooms are stored in memory — they reset on server restart. Swap in a database
  (e.g. Supabase/Postgres) if you want ratings to persist across deploys.
- `gameLogic.js` is isolated on purpose so you can reuse it for a "vs bot" minimax mode later.
