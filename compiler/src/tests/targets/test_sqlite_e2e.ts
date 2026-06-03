/**
 * SQLite end-to-end test.
 *
 * Compiles a small .marrow source to the SQLite target, installs deps, runs
 * migrations, boots the server, makes real HTTP requests, and confirms the
 * full CRUD round-trip works.
 *
 * This is the test that catches bugs the static checks in test_sqlite.ts
 * can't see — wrong db path, missing imports, runtime SQL translation
 * issues.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync, spawn, ChildProcess } from "child_process";
import { Lexer } from "../../lexer";
import { Parser } from "../../parser";
import { Lowering } from "../../lowering";
import { ConstraintSolver } from "../../solver";
import { optimize } from "../../optimizer";
import { SqliteEmitter } from "../../emit_sqlite";
import { createHash } from "crypto";

let passed = 0;
let failed = 0;
function ok(name: string) { console.log("  v " + name); passed++; }
function fail(name: string, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.log("  x " + name + ": " + msg);
  failed++;
}

const SAMPLE = `
system TestApi {
  domain: marketplace

  entity Widget {
    owns: [
      name: string,
      quantity: uint,
      price: float
    ]
    constraints: [
      quantity >= 0,
      price > 0
    ]
  }
}
`;

const JWT_SECRET = "test-secret-shhhhhh-long-enough-for-prod-use-32+chars";
const PORT = 17389; // less likely to collide than 3000

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, intervalMs = 200): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error("waitFor timed out");
}

async function run() {
  console.log("MarrowScript SQLite E2E Test\n");

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "marrowscript-sqlite-e2e-"));
  let serverProc: ChildProcess | null = null;

  try {
    // 1. Compile to SQLite target
    const tokens = new Lexer(SAMPLE).tokenize();
    const ast = new Parser(tokens).parse();
    const hash = createHash("sha256").update(SAMPLE).digest("hex").slice(0, 16);
    const ir = new Lowering().lower(ast, hash);
    for (let i = 0; i < ir.length; i++) {
      ir[i] = optimize(ir[i]).system;
    }
    const solver = new ConstraintSolver();
    for (const sys of ir) {
      sys.resolution = solver.solve(sys).resolution;
    }
    const files = new SqliteEmitter().emit(ir[0]);
    for (const f of files) {
      const target = path.join(tmpRoot, f.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, f.content, "utf-8");
    }
    ok("Emitted " + files.length + " files");

    // 2. Install deps. Use the install root from the compiler so we don't
    // re-download on every test run.
    console.log("\n  (npm install — first run only)");
    execSync("npm install --silent --no-audit --no-fund", { cwd: tmpRoot, stdio: "pipe" });
    ok("npm install succeeded");

    // 3. Configure env
    const dbPath = path.join(tmpRoot, "test_api.db");
    fs.writeFileSync(path.join(tmpRoot, ".env"),
      `JWT_SECRET=${JWT_SECRET}\nPORT=${PORT}\nNODE_ENV=development\nSQLITE_PATH=${dbPath.replace(/\\/g, "/")}\n`);
    ok("Wrote .env");

    // 4. Run migrations (with explicit SQLITE_PATH)
    execSync("npx ts-node src/migrate.ts", {
      cwd: tmpRoot, stdio: "pipe",
      env: { ...process.env, SQLITE_PATH: dbPath },
    });
    ok("Migrations applied cleanly");

    // 5. Boot server
    serverProc = spawn("npx", ["ts-node", "src/index.ts"], {
      cwd: tmpRoot, stdio: "pipe",
      env: { ...process.env, JWT_SECRET, PORT: String(PORT), SQLITE_PATH: dbPath },
      shell: true,
    });

    // 6. Wait for server to be listening
    await waitFor(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/health/live`);
        return res.ok;
      } catch { return false; }
    }, 30000);
    ok("Server booted and /health/live returned 200");

    // 7. Generate a JWT
    const jwt = require(path.join(tmpRoot, "node_modules", "jsonwebtoken"));
    const token = jwt.sign({ sub: "test-user" }, JWT_SECRET, { algorithm: "HS256", expiresIn: "1h" });

    // 8. CREATE — POST /widgets
    const createRes = await fetch(`http://127.0.0.1:${PORT}/widgets`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ name: "Sprocket", quantity: 5, price: 9.99 }),
    });
    if (createRes.status !== 201) {
      const txt = await createRes.text();
      throw new Error(`POST /widgets returned ${createRes.status}: ${txt}`);
    }
    const created = await createRes.json() as any;
    if (!created.id) throw new Error("created widget has no id");
    if (created.name !== "Sprocket") throw new Error("name mismatch: " + created.name);
    if (created.quantity !== 5) throw new Error("quantity mismatch: " + created.quantity);
    ok("POST /widgets returned the created row");

    // 9. READ — GET /widgets/:id
    const readRes = await fetch(`http://127.0.0.1:${PORT}/widgets/${created.id}`, {
      headers: { "Authorization": `Bearer ${token}` },
    });
    if (readRes.status !== 200) throw new Error(`GET /widgets/:id returned ${readRes.status}`);
    const read = await readRes.json() as any;
    if (read.id !== created.id) throw new Error("READ id mismatch");
    ok("GET /widgets/:id returned the row");

    // 10. LIST — GET /widgets
    const listRes = await fetch(`http://127.0.0.1:${PORT}/widgets`, {
      headers: { "Authorization": `Bearer ${token}` },
    });
    if (listRes.status !== 200) throw new Error(`GET /widgets returned ${listRes.status}`);
    const list = await listRes.json() as any;
    if (!Array.isArray(list.items)) throw new Error("list.items not array");
    if (list.total !== 1) throw new Error(`expected 1 row, got total=${list.total}, items=${JSON.stringify(list.items)}`);
    ok("GET /widgets returned paginated list with total=1");

    // 11. UPDATE — PUT /widgets/:id (this exercises the RETURNING * + NOW() path)
    const updateRes = await fetch(`http://127.0.0.1:${PORT}/widgets/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ quantity: 3 }),
    });
    if (updateRes.status !== 200) {
      const txt = await updateRes.text();
      throw new Error(`PUT /widgets/:id returned ${updateRes.status}: ${txt}`);
    }
    const updated = await updateRes.json() as any;
    if (updated.quantity !== 3) throw new Error("UPDATE didn't apply: quantity=" + updated.quantity);
    // Don't check updated_at !== created.updated_at — SQLite's datetime('now')
    // has 1-second granularity and this test runs faster than that. The fact
    // that the new value is returned proves the UPDATE-with-RETURNING path works.
    ok("PUT /widgets/:id applied the change");

    // 12. DELETE — DELETE /widgets/:id
    const delRes = await fetch(`http://127.0.0.1:${PORT}/widgets/${created.id}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${token}` },
    });
    if (delRes.status !== 204) throw new Error(`DELETE returned ${delRes.status}`);
    ok("DELETE /widgets/:id returned 204");

    // 13. Verify deletion
    const verifyRes = await fetch(`http://127.0.0.1:${PORT}/widgets/${created.id}`, {
      headers: { "Authorization": `Bearer ${token}` },
    });
    if (verifyRes.status !== 404) throw new Error(`expected 404 after DELETE, got ${verifyRes.status}`);
    ok("GET after DELETE returns 404");

    // 14. Validate Zod constraint enforcement (quantity must be >= 0)
    const invalidRes = await fetch(`http://127.0.0.1:${PORT}/widgets`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ name: "Bad", quantity: -1, price: 1.0 }),
    });
    if (invalidRes.status !== 400) throw new Error(`expected 400 for invalid input, got ${invalidRes.status}`);
    ok("POST with invalid input returns 400");

    // 15. Auth enforcement
    const noAuthRes = await fetch(`http://127.0.0.1:${PORT}/widgets`);
    if (noAuthRes.status !== 401) throw new Error(`expected 401 without auth, got ${noAuthRes.status}`);
    ok("Unauthenticated request returns 401");
  } catch (e) {
    fail("E2E flow", e);
  } finally {
    if (serverProc && !serverProc.killed) {
      try { serverProc.kill("SIGTERM"); } catch {}
      try {
        // Windows: also kill the spawned tree
        if (process.platform === "win32" && typeof serverProc.pid === "number") {
          execSync(`taskkill /pid ${serverProc.pid} /T /F`, { stdio: "pipe" });
        }
      } catch {}
    }
    // Best-effort cleanup. Sometimes Windows holds the .db file lock briefly.
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }

  summary();
}

function summary() {
  console.log("\n" + "═".repeat(40));
  console.log("Results: " + passed + " passed, " + failed + " failed");
  console.log("═".repeat(40));
  if (failed > 0) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(1); });
