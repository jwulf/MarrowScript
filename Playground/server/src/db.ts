import Database from "better-sqlite3";
import * as path from "path";
import * as fs from "fs";

class PlaygroundDB {
  private _db: Database.Database | null = null;

  get instance(): Database.Database {
    if (!this._db) {
      const dbDir = path.resolve(process.cwd(), "data");
      if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
      this._db = new Database(path.join(dbDir, "playground.db"));
      this._db.pragma("journal_mode = WAL");
    }
    return this._db;
  }

  initialize() {
    this.instance.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        name TEXT,
        picture TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        last_compile_at TEXT,
        total_compiles INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS compiles (
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
    `);
  }
}

export const db = new PlaygroundDB();
