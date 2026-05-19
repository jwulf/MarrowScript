# MarrowForge UI

Black-and-silver web UI for the MarrowForge backend. Vite + React + TypeScript + framer-motion.

## What it does

- Compose a `RepoForgeRequest` (two GitHub URLs + a preset + a complexity slider).
- Click **Forge** to fire a single `POST /repo_forge_requests/forge-from-repos`.
- Watch the pipeline advance step by step (ingest A → ingest B → analyze → generate).
- Read the artifact, the analysis JSON, the repo summaries, and the cognition trace timeline in tabbed panels.

## Setup

The UI talks to the generated MarrowForge backend at `http://localhost:3000`. Vite proxies `/api/*` to that host so the browser doesn't need to think about CORS.

```bash
# 1. Start the backend (one terminal)
cd ../output
npx ts-node src/index.ts

# 2. Mint a dev token
npx ts-node bin/mint_dev_token.ts --sub frontend-dev
# → copy the token printed to stdout

# 3. Install + run the UI (another terminal)
cd ../ui
npm install
npm run dev
# → http://localhost:5173

# 4. Paste the token into the "Token" bar at the top of the page.
```

That's it. Type a request, drag the complexity slider, click **Forge**.

## Pointing at a different backend

Set `MARROWFORGE_BASE` before `npm run dev`:

```bash
MARROWFORGE_BASE=http://192.168.0.20:3000 npm run dev
```

## Build for production

```bash
npm run build
# emits dist/ — serve those static files behind any host that proxies
# /api to MarrowForge.
```
