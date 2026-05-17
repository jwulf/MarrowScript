import { Router, Request, Response } from "express";
import { execFileSync } from "child_process";
import { v4 as uuid } from "uuid";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { extractUser } from "./auth.js";
import { db } from "./db.js";

export const compileRouter = Router();

const COMPILER_PATH = path.resolve(process.env.COMPILER_PATH || "../../compiler");
const RATE_LIMIT_PER_MIN = parseInt(process.env.RATE_LIMIT_PER_MIN || "10");
const COMPILE_TIMEOUT_MS = 10_000;
const MAX_SOURCE_BYTES = 50 * 1024; // 50KB

interface CompiledFile {
  path: string;
  content: string;
  language: string;
}

/**
 * POST /api/compile
 * Body: { source: string, target: "express" | "sqlite" | "prisma" | "nakama" }
 * Returns: { files: CompiledFile[], duration_ms, errors? }
 */
compileRouter.post("/", (req: Request, res: Response) => {
  // Auth check
  const user = extractUser(req);
  if (!user) { res.status(401).json({ error: "Sign in required to compile" }); return; }

  // Rate limit per user
  if (!checkRateLimit(user.userId)) {
    res.status(429).json({ error: "Rate limit exceeded. Max 10 compiles per minute.", retry_after_s: 60 });
    return;
  }

  const { source, target = "express" } = req.body;

  // Validate input
  if (!source || typeof source !== "string") {
    res.status(400).json({ error: "Missing 'source' field" });
    return;
  }
  if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) {
    res.status(400).json({ error: `Source too large (max ${MAX_SOURCE_BYTES / 1024}KB)` });
    return;
  }
  if (!["express", "sqlite", "prisma", "nakama"].includes(target)) {
    res.status(400).json({ error: "Invalid target. Options: express, sqlite, prisma, nakama" });
    return;
  }

  const startMs = Date.now();
  const compileId = uuid();
  const sourceHash = createHash("sha256").update(source).digest("hex").slice(0, 16);

  // Create sandbox directory
  const tmpDir = path.join(os.tmpdir(), `marrow-${compileId}`);
  const inputFile = path.join(tmpDir, "input.marrow");
  const outputDir = target === "express" ? path.join(tmpDir, "output") : path.join(tmpDir, `output-${target}`);

  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(inputFile, source);

    // Run compiler
    const args = ["compile", inputFile];
    if (target !== "express") args.push("--target", target);

    const cliPath = path.join(COMPILER_PATH, "src", "cli.ts");
    const tsNodePath = path.join(COMPILER_PATH, "node_modules", ".bin", "ts-node");

    let stdout: string;
    try {
      stdout = execFileSync("node", [
        "--max-old-space-size=2048",
        path.join(COMPILER_PATH, "node_modules", "ts-node", "dist", "bin.js"),
        cliPath,
        ...args,
      ], {
        encoding: "utf-8",
        timeout: COMPILE_TIMEOUT_MS,
        cwd: tmpDir,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, NODE_OPTIONS: "" },
      });
    } catch (e: any) {
      const stderr = e.stderr || e.message || "Unknown compiler error";
      const durationMs = Date.now() - startMs;

      // Record failed compile
      recordCompile(compileId, user.userId, sourceHash, target, 0, durationMs, stderr);

      // Parse error message for user-friendly display
      const errorLines = stderr.split("\n").filter((l: string) => l.includes("error") || l.includes("Error") || l.includes("Parse"));

      res.json({
        files: [],
        errors: errorLines.length > 0 ? errorLines : [stderr.slice(0, 500)],
        duration_ms: durationMs,
      });
      return;
    }

    // Read generated files
    const actualOutputDir = findOutputDir(tmpDir, target);
    const files: CompiledFile[] = [];

    if (actualOutputDir && fs.existsSync(actualOutputDir)) {
      readFilesRecursive(actualOutputDir, actualOutputDir, files);
    }

    const durationMs = Date.now() - startMs;

    // Record successful compile
    recordCompile(compileId, user.userId, sourceHash, target, files.length, durationMs, null);

    res.json({ files, duration_ms: durationMs, errors: [] });
  } finally {
    // Cleanup sandbox
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

// ─── Helpers ──────────────────────────────────────────────────────

function findOutputDir(tmpDir: string, target: string): string | null {
  // The compiler writes to different dirs based on target
  const candidates = [
    path.join(tmpDir, `output-${target}`),
    path.join(tmpDir, "output"),
    path.join(tmpDir, "output-sqlite"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  // Check if any directory was created
  const entries = fs.readdirSync(tmpDir, { withFileTypes: true });
  const dirs = entries.filter(e => e.isDirectory() && e.name.startsWith("output"));
  if (dirs.length > 0) return path.join(tmpDir, dirs[0].name);
  return null;
}

function readFilesRecursive(baseDir: string, dir: string, files: CompiledFile[]) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      readFilesRecursive(baseDir, fullPath, files);
    } else {
      const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, "/");
      try {
        const content = fs.readFileSync(fullPath, "utf-8");
        const ext = path.extname(entry.name).slice(1);
        const language = ext === "ts" ? "typescript" : ext === "sql" ? "sql" : ext === "json" ? "json" : ext === "yaml" || ext === "yml" ? "yaml" : "text";
        files.push({ path: relativePath, content, language });
      } catch {}
    }
  }
}

function checkRateLimit(userId: string): boolean {
  const dbInst = db.instance;
  const window = new Date().toISOString().slice(0, 16); // minute-level window

  const row = dbInst.prepare("SELECT count FROM rate_limits WHERE user_id = ? AND window = ?").get(userId, window) as any;

  if (!row) {
    // Clean old windows and insert new
    dbInst.prepare("DELETE FROM rate_limits WHERE user_id = ? AND window != ?").run(userId, window);
    dbInst.prepare("INSERT OR REPLACE INTO rate_limits (user_id, window, count) VALUES (?, ?, 1)").run(userId, window);
    return true;
  }

  if (row.count >= RATE_LIMIT_PER_MIN) return false;

  dbInst.prepare("UPDATE rate_limits SET count = count + 1 WHERE user_id = ? AND window = ?").run(userId, window);
  return true;
}

function recordCompile(id: string, userId: string, sourceHash: string, target: string, fileCount: number, durationMs: number, error: string | null) {
  db.instance.prepare(
    "INSERT INTO compiles (id, user_id, source_hash, target, file_count, duration_ms, error) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, userId, sourceHash, target, fileCount, durationMs, error);

  db.instance.prepare("UPDATE users SET total_compiles = total_compiles + 1, last_compile_at = datetime('now') WHERE id = ?").run(userId);
}

// Ensure rate_limits table exists
db.instance.exec(`
  CREATE TABLE IF NOT EXISTS rate_limits (
    user_id TEXT NOT NULL,
    window TEXT NOT NULL,
    count INTEGER DEFAULT 0,
    PRIMARY KEY (user_id, window)
  );
`);
