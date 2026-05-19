/**
 * MarrowScript Project Scaffolder â€” `bone init`
 * Creates a new MarrowScript project with sensible defaults for a chosen domain.
 */

import * as fs from "fs";
import * as path from "path";

export type ScaffoldDomain =
  | "multiplayer_game"
  | "saas_platform"
  | "iot_system"
  | "social_network"
  | "marketplace"
  | "realtime_collaboration"
  | "cognitive_scaffold";

const TEMPLATES: Record<ScaffoldDomain, string> = {
  multiplayer_game: `// Compile with: marrowc compile {name}.marrow --target nakama
// for Nakama TypeScript runtime output instead of Express/PostgreSQL
system MyGame {
  domain: multiplayer_game

  entity Player {
    owns: [
      username: string,
      score: uint
    ]
    constraints: [
      username.unique,
      username.length in 3..32,
      score >= 0
    ]
    states: active -> suspended | deleted
    auth: jwt
  }

  capability award_points(player: Player, points: uint) {
    requires: [points > 0, player.state == "active"]
    effects: [player.score += points]
    sync: eventual
  }

  store PlayerStore {
    engine: postgresql
    schema: {
      id: uuid,
      username: string,
      score: uint,
      state: string
    }
  }

  channel game_lobby {
    transport: websocket
    ordering: causal
    participants: set<Player>
    persistence: last_100
  }
}
`,

  saas_platform: `system MySaaS {
  domain: saas_platform

  entity Tenant {
    owns: [
      name: string,
      plan: string,
      active: bool
    ]
    constraints: [
      name.length in 1..100,
      plan in ["free", "pro", "enterprise"]
    ]
    states: trialing -> active -> suspended | cancelled
    auth: oauth2
  }

  entity User {
    owns: [
      email: string,
      tenant_id: uuid,
      role: string
    ]
    constraints: [
      email.unique,
      role in ["admin", "member", "viewer"]
    ]
    auth: oauth2
  }

  capability invite_user(tenant: Tenant, email: string, role: string) {
    requires: [tenant.state == "active", role in ["admin", "member", "viewer"]]
    effects: []
    emits: UserInvited
    sync: transactional
  }

  event UserInvited {
    payload: {
      tenant_id: uuid,
      email: string,
      role: string,
      invited_at: timestamp
    }
    delivery: at_least_once
    ttl: 7d
  }

  store TenantStore {
    engine: postgresql
    schema: {
      id: uuid,
      name: string,
      plan: string,
      active: bool,
      state: string
    }
  }
}
`,

  iot_system: `system MyIoT {
  domain: iot_system

  entity Device {
    owns: [
      serial: string,
      firmware_version: string,
      last_seen: timestamp,
      battery: uint
    ]
    constraints: [
      serial.unique,
      battery <= 100
    ]
    states: online -> offline -> retired
    auth: apikey
  }

  entity Reading {
    owns: [
      device_id: uuid,
      sensor: string,
      value: float,
      recorded_at: timestamp
    ]
  }

  capability ingest_reading(device: Device, sensor: string, value: float) {
    requires: [device.state == "online"]
    effects: [device.last_seen = now()]
    emits: ReadingRecorded
    sync: eventual
  }

  event ReadingRecorded {
    payload: {
      device_id: uuid,
      sensor: string,
      value: float
    }
    delivery: at_least_once
    ttl: 1d
  }

  store DeviceStore {
    engine: dynamodb
    schema: {
      id: uuid,
      serial: string,
      firmware_version: string,
      battery: uint,
      state: string
    }
  }
}
`,

  social_network: `system MySocial {
  domain: social_network

  entity User {
    owns: [
      handle: string,
      display_name: string,
      followers: set<uuid>,
      following: set<uuid>
    ]
    constraints: [
      handle.unique,
      handle.length in 3..30
    ]
    auth: oauth2
  }

  entity Post {
    owns: [
      author_id: uuid,
      content: string,
      likes: uint
    ]
    constraints: [
      content.length in 1..500
    ]
  }

  capability follow_user(follower: User, target: User) {
    requires: [follower != target]
    effects: [
      follower.following += target.id,
      target.followers += follower.id
    ]
    sync: eventual
  }

  channel feed {
    transport: websocket
    ordering: causal
    participants: set<User>
    persistence: last_100
  }
}
`,

  marketplace: `system MyMarket {
  domain: marketplace

  entity Listing {
    owns: [
      seller_id: uuid,
      title: string,
      price: uint,
      stock: uint
    ]
    constraints: [
      title.length in 1..200,
      price > 0,
      stock >= 0
    ]
    states: draft -> active -> sold_out | archived
    auth: oauth2
  }

  entity Order {
    owns: [
      buyer_id: uuid,
      listing_id: uuid,
      quantity: uint,
      total: uint
    ]
    states: pending -> paid -> shipped -> delivered | cancelled
  }

  capability purchase(buyer: User, listing: Listing, qty: uint) {
    requires: [
      listing.state == "active",
      listing.stock >= qty
    ]
    effects: [
      listing.stock -= qty
    ]
    emits: OrderCreated
    sync: transactional
  }

  event OrderCreated {
    payload: {
      order_id: uuid,
      buyer_id: uuid,
      listing_id: uuid,
      total: uint
    }
    delivery: exactly_once
    ttl: 30d
  }
}
`,

  realtime_collaboration: `system MyCollab {
  domain: realtime_collaboration

  entity Document {
    owns: [
      title: string,
      owner_id: uuid,
      content: json,
      version: uint
    ]
    constraints: [
      version >= 1
    ]
    auth: jwt
  }

  entity Cursor {
    owns: [
      document_id: uuid,
      user_id: uuid,
      position: uint,
      color: string
    ]
  }

  capability apply_change(doc: Document, user: User, change: json) {
    requires: [doc.owner_id == user.id or doc.collaborators contains user.id]
    effects: [
      doc.version += 1,
      doc.content = change
    ]
    emits: DocumentChanged
    sync: realtime
  }

  channel doc_session {
    transport: websocket
    ordering: causal
    participants: set<User>
    persistence: last_1000
  }

  event DocumentChanged {
    payload: {
      document_id: uuid,
      user_id: uuid,
      version: uint
    }
    delivery: at_least_once
    ttl: 1d
  }
}
`,

  cognitive_scaffold: `// Compile with: marrowc compile {name}.marrow
// LLM Harness scaffold — model-agnostic deterministic orchestration over
// weak/small language models. The compiler emits providers, prompts, router,
// validation, repair, cache, budget, and traces. The model is constrained;
// the runtime is intelligent.
system MyHarness {
  domain: cognitive_scaffold

  // ── Entities ──────────────────────────────────────────────────────────────

  entity Doc {
    owns: [
      title: string,
      body: string,
      kind: string
    ]
    constraints: [
      kind in ["bug", "feature", "question"]
    ]
  }

  // ── Stores ────────────────────────────────────────────────────────────────

  store DocStore {
    engine: postgresql
    schema: {
      id: uuid,
      title: string,
      body: string,
      kind: string,
      created_at: timestamp,
      updated_at: timestamp
    }
  }

  // ── Extension points (prompt bodies live here, preserved across recompile)─

  extension_point tmpl_classify(body: string) {
    returns: string
    stable: true
  }

  // ── Models ────────────────────────────────────────────────────────────────

  model Tiny {
    provider: ollama
    name: "qwen2.5-coder:1.5b"
    context_window: 32000
    max_output: 256
    temperature: 0.0
    cost_class: tiny
    latency_class: fast
  }

  // ── Prompt ────────────────────────────────────────────────────────────────

  prompt classify(body: string) {
    model: Tiny
    template: "extension_point:tmpl_classify"
    returns: string
    timeout: 5s
    idempotent: true
    validate: schema_only
    on_invalid: retry
    retry: { max_attempts: 2, backoff: fixed, interval: 200ms }
    cache: { key: hash(body), ttl: 1h }
  }

  // ── Capability ────────────────────────────────────────────────────────────

  capability assign_kind(d: Doc, kind: string) {
    requires: [
      kind in ["bug", "feature", "question"]
    ]
    effects: [d.kind = kind]
    sync: transactional
  }

  // ── Policy (audit + rate-limit) ───────────────────────────────────────────

  policy harness {
    rate_limit: 60 per 1m
    audit: true
  }
}
`,
};

export interface ScaffoldOptions {
  name: string;
  domain: ScaffoldDomain;
  outDir: string;
}

export function scaffold(opts: ScaffoldOptions): { created: string[] } {
  const created: string[] = [];

  if (!fs.existsSync(opts.outDir)) {
    fs.mkdirSync(opts.outDir, { recursive: true });
  }

  // Main .marrow file
  const mainFile = path.join(opts.outDir, `${opts.name}.marrow`);
  let content = TEMPLATES[opts.domain];
  // Replace the placeholder `system <Name> {` with the user's project name.
  // We use a multiline regex anchored on word boundary so templates that lead
  // with header comments still get rewritten correctly.
  content = content.replace(/\bsystem\s+\w+\s*\{/, `system ${pascalCase(opts.name)} {`);
  fs.writeFileSync(mainFile, content, "utf-8");
  created.push(mainFile);

  // README
  const readmePath = path.join(opts.outDir, "README.md");
  fs.writeFileSync(readmePath, `# ${opts.name}

MarrowScript project (domain: ${opts.domain}).

## Compile

\`\`\`bash
bone compile ${opts.name}.marrow
\`\`\`

The output will be written to \`./output/\` as a complete Node.js project.
`, "utf-8");
  created.push(readmePath);

  return { created };
}

function pascalCase(s: string): string {
  return s.replace(/(^|[-_\s])(\w)/g, (_, __, c) => c.toUpperCase());
}
