import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { authRouter } from "./auth.js";
import { compileRouter } from "./compile.js";
import { examplesRouter } from "./examples.js";
import { db } from "./db.js";

const app = express();
const PORT = parseInt(process.env.PORT || "3001");
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";

// Initialize database
db.initialize();

// Middleware
app.use(helmet());
app.use(cors({ origin: CLIENT_URL, credentials: true }));
app.use(express.json({ limit: "50kb" }));

// Global rate limit (100 req/min per IP regardless of auth)
app.use(rateLimit({ windowMs: 60_000, max: 100 }));

// Routes
app.use("/api/auth", authRouter);
app.use("/api/compile", compileRouter);
app.use("/api/examples", examplesRouter);

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", version: "0.1.0" });
});

app.listen(PORT, () => {
  console.log(`[playground-server] Running on port ${PORT}`);
  console.log(`  Client URL: ${CLIENT_URL}`);
  console.log(`  Compiler: ${process.env.COMPILER_PATH || "../../compiler"}`);
});
