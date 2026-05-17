import { Router, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { v4 as uuid } from "uuid";
import { db } from "./db.js";

export const authRouter = Router();

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";

/**
 * POST /api/auth/google
 * Body: { code: string } (the OAuth authorization code from Google)
 * Returns: { token, user }
 */
authRouter.post("/google", async (req: Request, res: Response) => {
  const { code, credential } = req.body;

  try {
    let email: string;
    let name: string;
    let picture: string;

    if (credential) {
      // Google One Tap (ID token directly)
      const payload = decodeJwtPayload(credential);
      email = payload.email;
      name = payload.name || email.split("@")[0];
      picture = payload.picture || "";
    } else if (code) {
      // Standard OAuth code exchange
      const tokens = await exchangeCode(code);
      const payload = decodeJwtPayload(tokens.id_token);
      email = payload.email;
      name = payload.name || email.split("@")[0];
      picture = payload.picture || "";
    } else {
      res.status(400).json({ error: "Missing code or credential" });
      return;
    }

    // Upsert user
    const dbInst = db.instance;
    let user = dbInst.prepare("SELECT * FROM users WHERE email = ?").get(email) as any;

    if (!user) {
      const id = uuid();
      dbInst.prepare("INSERT INTO users (id, email, name, picture) VALUES (?, ?, ?, ?)").run(id, email, name, picture);
      user = { id, email, name, picture, total_compiles: 0 };
    }

    // Issue JWT
    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: "7d" });

    res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name, picture: user.picture, total_compiles: user.total_compiles },
    });
  } catch (err: any) {
    console.error("Auth error:", err.message);
    res.status(401).json({ error: "Authentication failed" });
  }
});

/**
 * GET /api/auth/me
 * Returns current user info from JWT
 */
authRouter.get("/me", (req: Request, res: Response) => {
  const user = extractUser(req);
  if (!user) { res.status(401).json({ error: "Not authenticated" }); return; }

  const dbUser = db.instance.prepare("SELECT * FROM users WHERE id = ?").get(user.userId) as any;
  if (!dbUser) { res.status(401).json({ error: "User not found" }); return; }

  res.json({
    id: dbUser.id,
    email: dbUser.email,
    name: dbUser.name,
    picture: dbUser.picture,
    total_compiles: dbUser.total_compiles,
  });
});

// ─── Helpers ──────────────────────────────────────────────────────

async function exchangeCode(code: string): Promise<any> {
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: `${CLIENT_URL}/auth/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!resp.ok) throw new Error(`Token exchange failed: ${resp.status}`);
  return resp.json();
}

function decodeJwtPayload(token: string): any {
  const parts = token.split(".");
  if (parts.length < 2) throw new Error("Invalid token");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString());
}

export function extractUser(req: Request): { userId: string; email: string } | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  try {
    return jwt.verify(auth.slice(7), JWT_SECRET) as any;
  } catch {
    return null;
  }
}
