# MarrowScript Playground — Plan

A web-based live compiler playground. Users write `.marrow` files in the browser, hit compile, and see the generated output instantly. Compiler stays server-side — never shipped to the client.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Browser (public)                                       │
│  ┌───────────────────────┐ ┌─────────────────────────┐ │
│  │  Monaco Editor         │ │  File Tree Viewer       │ │
│  │  (.marrow input)       │ │  (generated output)     │ │
│  └───────────────────────┘ └─────────────────────────┘ │
│           │ POST /api/compile                           │
└───────────┼─────────────────────────────────────────────┘
            ▼
┌─────────────────────────────────────────────────────────┐
│  API Server (private — your infra)                      │
│  ┌─────────────┐ ┌──────────────┐ ┌──────────────────┐ │
│  │  Auth (JWT)  │ │  Rate Limit  │ │  Compile Worker  │ │
│  │  Google OAuth│ │  10/min free │ │  marrowc compile │ │
│  └─────────────┘ └──────────────┘ └──────────────────┘ │
│                                                         │
│  MarrowScript compiler (NEVER leaves this box)          │
└─────────────────────────────────────────────────────────┘
```

---

## Auth Flow

1. User lands on playground.marrowscript.dev
2. Sees a "Sign in with Google" button + a read-only example output
3. Signs in via Google OAuth 2.0 (one click)
4. Gets a JWT stored in httpOnly cookie
5. Can now compile (rate-limited: 10 compiles/min free tier)

No email/password. No verification emails. No friction.

---

## Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Frontend | React + Vite + Tailwind | Fast, everyone knows it |
| Editor | Monaco Editor | VS Code experience in the browser, syntax highlighting |
| File viewer | Custom tree component | Show generated files with tabs |
| API | Express or Hono | Lightweight, handles auth + compile |
| Auth | Google OAuth 2.0 → JWT | One-click sign-in, no password management |
| Compiler | `marrowc compile` (child_process) | Server-side only, never exposed |
| Database | SQLite (user accounts + usage tracking) | Zero-config, one file |
| Hosting | Railway / Fly.io / VPS | Needs persistent process for compiler |
| Domain | playground.marrowscript.dev | Subdomain of future main site |

---

## Pages

### 1. Landing / Playground (single page app)

```
┌──────────────────────────────────────────────────────────────────┐
│  [MarrowScript Playground]              [Sign In with Google] 🔵 │
├────────────────────────────────┬─────────────────────────────────┤
│                                │  Generated Output               │
│  .marrow editor                │                                 │
│                                │  📁 src/                        │
│  system MyApp {                │    📄 index.ts                  │
│    domain: saas_platform       │    📄 routes/user.ts            │
│                                │    📄 schemas.ts                │
│    entity User {               │  📁 migrations/                 │
│      owns: [                   │    📄 user.sql                  │
│        name: string,           │  📄 package.json                │
│        email: string           │  📄 openapi.yaml                │
│      ]                         │                                 │
│    }                           │  ─────────────────────          │
│    ...                         │  // index.ts (preview)          │
│  }                             │  import express from "express"; │
│                                │  ...                            │
│                                │                                 │
├────────────────────────────────┴─────────────────────────────────┤
│  [▶ Compile]  [Target: express ▾]  [SQLite ▾]   10/10 remaining │
└──────────────────────────────────────────────────────────────────┘
```

### 2. Examples dropdown

Pre-loaded `.marrow` files users can pick:
- Marketplace (full e-commerce)
- Inventory Platform (multiplayer game)
- Delivery Platform (pipelines + algorithms)
- Harness Minimal (LLM cognition — MarrowScript only)
- Custom (blank)

---

## API Endpoints

### `POST /api/auth/google`
- Receives Google OAuth code
- Exchanges for tokens, extracts email/name
- Upserts user in SQLite
- Returns JWT (httpOnly cookie, 7d expiry)

### `GET /api/auth/me`
- Returns current user info + remaining compiles

### `POST /api/compile`
- Auth required (JWT)
- Body: `{ source: string, target: "express" | "sqlite" | "prisma" | "nakama" }`
- Rate limit: 10/min (free), 100/min (paid — future)
- Runs `marrowc compile` in a sandboxed temp dir
- Returns: `{ files: [{ path, content, language }], errors: [], duration_ms }`
- Timeout: 10s max per compile
- Max input: 50KB

### `GET /api/examples/:name`
- Returns pre-loaded example `.marrow` source

---

## Security

| Threat | Mitigation |
|--------|------------|
| Compiler escape / code injection | Compile in temp dir, no network, rm -rf after. The compiler is deterministic — no eval, no shell, no fs outside output dir |
| DoS via large input | 50KB max body, 10s timeout, rate limit |
| Auth token theft | httpOnly cookie, secure flag, SameSite=Strict |
| Compiler source exposure | Binary only on server. Client never sees source. API returns generated output only |
| Abuse (spam accounts) | Google OAuth = real identity. Rate limit per user. Ban hammer for abuse |

---

## Sandbox Model

Each compile request:
1. Create temp dir: `/tmp/marrow-<uuid>/`
2. Write user's `.marrow` source to `input.marrow`
3. Run: `marrowc compile input.marrow --target <target>` with:
   - Timeout: 10 seconds
   - No network (compiler doesn't need it)
   - Working dir: the temp dir
4. Read all generated files from the output directory
5. Delete temp dir
6. Return file contents as JSON

The compiler never writes outside its output dir (by design — deterministic, no side effects).

---

## Database Schema (SQLite)

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  picture TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  last_compile_at TEXT,
  total_compiles INTEGER DEFAULT 0
);

CREATE TABLE compiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  target TEXT NOT NULL,
  file_count INTEGER,
  duration_ms INTEGER,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE rate_limits (
  user_id TEXT NOT NULL,
  window TEXT NOT NULL,
  count INTEGER DEFAULT 0,
  PRIMARY KEY (user_id, window)
);
```

---

## Monetization (future, not v1)

| Tier | Price | Limits |
|------|-------|--------|
| Free | $0 | 10 compiles/min, express target only |
| Pro | $9/mo | 100 compiles/min, all targets, download zip, API access |
| Team | $29/mo | Shared examples, private snippets, priority support |

v1 is free-only with Google sign-in. Monetization comes after proving people use it.

---

## Implementation Order

### Phase 1 — MVP (3-4 days)
1. Vite + React frontend with Monaco Editor
2. Express API with Google OAuth
3. `/api/compile` endpoint calling `marrowc`
4. File tree viewer showing output
5. One pre-loaded example
6. Deploy to Railway/Fly

### Phase 2 — Polish (2-3 days)
7. Syntax highlighting for `.marrow` (Monaco custom language)
8. Multiple examples dropdown
9. Target selector (express, sqlite, prisma)
10. Error display (type errors, parse errors with line markers)
11. "Share" button (generates URL with encoded source)

### Phase 3 — Growth (ongoing)
12. Usage analytics (what do people try to build?)
13. Rate limit UI ("5/10 compiles remaining, resets in 42s")
14. Download output as .zip
15. Keyboard shortcuts (Ctrl+Enter = compile)
16. Mobile responsive layout
17. SEO landing page (playground.marrowscript.dev)

---

## Success Metrics

| Metric | Target (30 days post-launch) |
|--------|-----|
| Sign-ups | 200+ |
| Compiles | 1000+ |
| Return visitors (2+ days) | 30% |
| Conversion to GitHub star | 10% |
| Time to first compile (new user) | < 30 seconds |

---

## Domain / Hosting

- `playground.marrowscript.dev` (or `play.marrowscript.dev`)
- Needs: marrowscript.dev domain ($12/year)
- Deploy: Railway ($5/mo hobby) or Fly.io (free tier might work)
- The compiler binary runs on the server — needs Node.js 18+ runtime

---

## What stays private

- The MarrowScript compiler source code (phases 14-22, cognition layer)
- The compiler binary on the server
- User data (emails, compile history)

## What's public

- The playground frontend (can be open source — it's just a UI)
- The BoneScript examples (already public on GitHub)
- The output users see (they generated it, it's theirs)
