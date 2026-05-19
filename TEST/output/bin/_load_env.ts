/**
 * Tiny synchronous .env loader. Imported FIRST by bin scripts so the env
 * is populated into process.env before any provider classes evaluate their
 * constructors (which read process.env at construction time).
 *
 * No external dependency on dotenv — this is a 20-line parser that handles
 * the subset we need: KEY=VALUE lines, optional surrounding double-quotes,
 * `#` comments, blank lines.
 */

import * as fs from "fs";
import * as path from "path";

const candidates = [
  path.join(process.cwd(), ".env"),
  path.join(__dirname, "..", ".env"),
];

for (const file of candidates) {
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, "utf-8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // Strip a single layer of surrounding double quotes if present.
    if (val.startsWith("\"") && val.endsWith("\"") && val.length >= 2) {
      val = val.slice(1, -1);
    }
    // Don't override existing env (so shell-set vars take precedence).
    if (process.env[key] === undefined) process.env[key] = val;
  }
  // First match wins so `pwd/.env` beats `bin/../.env` (same file in our
  // case, but the order is documented).
  break;
}
