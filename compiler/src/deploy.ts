/**
 * MarrowScript Deploy (Phase 30)
 *
 * One-command deployment from compiled output to a cloud provider.
 *
 * Usage:
 *   marrowc deploy [output_dir] --target=docker    → Build + run locally
 *   marrowc deploy [output_dir] --target=fly       → Deploy to Fly.io
 *   marrowc deploy [output_dir] --target=railway   → Deploy to Railway
 *
 * What it does:
 *   1. Verifies the output directory has a valid compiled project
 *   2. Runs npm install (if needed)
 *   3. Builds the TypeScript
 *   4. Deploys to the target platform
 *
 * Prerequisites:
 *   - docker: Docker installed and running
 *   - fly: flyctl CLI installed + authenticated
 *   - railway: railway CLI installed + authenticated
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

export type DeployTarget = "docker" | "fly" | "railway" | "local";

export interface DeployOptions {
  outputDir: string;
  target: DeployTarget;
  port?: number;
  appName?: string;
}

export function deploy(options: DeployOptions): void {
  const { outputDir, target, port = 3000, appName } = options;
  const absDir = path.resolve(outputDir);

  // Verify output directory
  if (!fs.existsSync(absDir)) {
    console.error(`Error: Output directory not found: ${absDir}`);
    console.error("Run 'marrowc compile <file>' first.");
    process.exit(1);
  }

  if (!fs.existsSync(path.join(absDir, "package.json"))) {
    console.error(`Error: No package.json found in ${absDir}`);
    console.error("This doesn't look like a compiled MarrowScript project.");
    process.exit(1);
  }

  console.log(`[deploy] Target: ${target}`);
  console.log(`[deploy] Directory: ${absDir}`);
  console.log("");

  // Install dependencies if needed
  if (!fs.existsSync(path.join(absDir, "node_modules"))) {
    console.log("[deploy] Installing dependencies...");
    run("npm install", absDir);
  }

  switch (target) {
    case "local":
      deployLocal(absDir, port);
      break;
    case "docker":
      deployDocker(absDir, port, appName);
      break;
    case "fly":
      deployFly(absDir, appName);
      break;
    case "railway":
      deployRailway(absDir);
      break;
  }
}

function deployLocal(dir: string, port: number): void {
  console.log(`[deploy] Starting locally on port ${port}...`);
  console.log(`[deploy] Run: cd ${dir} && npm run dev`);
  console.log("");

  // Generate .env if missing
  const envFile = path.join(dir, ".env");
  if (!fs.existsSync(envFile)) {
    const envExample = path.join(dir, ".env.example");
    if (fs.existsSync(envExample)) {
      fs.copyFileSync(envExample, envFile);
      console.log("[deploy] Created .env from .env.example");
    }
  }

  run(`npm run dev`, dir);
}

function deployDocker(dir: string, port: number, appName?: string): void {
  const name = appName || path.basename(dir).toLowerCase().replace(/[^a-z0-9-]/g, "-");

  // Check Docker is available
  try { run("docker --version", dir, true); }
  catch { console.error("Error: Docker not found. Install Docker first."); process.exit(1); }

  // Ensure Dockerfile exists
  if (!fs.existsSync(path.join(dir, "Dockerfile"))) {
    console.log("[deploy] Generating Dockerfile...");
    generateDockerfile(dir, port);
  }

  console.log(`[deploy] Building Docker image: ${name}...`);
  run(`docker build -t ${name} .`, dir);

  console.log(`[deploy] Running container on port ${port}...`);
  run(`docker run -d --name ${name} -p ${port}:3000 --env-file .env ${name}`, dir);

  console.log("");
  console.log(`✓ Deployed! Running at http://localhost:${port}`);
  console.log(`  Stop: docker stop ${name}`);
  console.log(`  Logs: docker logs ${name}`);
}

function deployFly(dir: string, appName?: string): void {
  // Check flyctl is available
  try { run("flyctl version", dir, true); }
  catch { console.error("Error: flyctl not found. Install: curl -L https://fly.io/install.sh | sh"); process.exit(1); }

  // Check if fly.toml exists
  if (!fs.existsSync(path.join(dir, "fly.toml"))) {
    const name = appName || path.basename(dir).toLowerCase().replace(/[^a-z0-9-]/g, "-");
    console.log(`[deploy] Initializing Fly app: ${name}...`);
    run(`flyctl launch --name ${name} --no-deploy --region iad`, dir);
  }

  // Ensure Dockerfile exists
  if (!fs.existsSync(path.join(dir, "Dockerfile"))) {
    generateDockerfile(dir, 3000);
  }

  console.log("[deploy] Deploying to Fly.io...");
  run("flyctl deploy", dir);

  console.log("");
  console.log("✓ Deployed to Fly.io!");
  console.log("  URL: flyctl status");
  console.log("  Logs: flyctl logs");
}

function deployRailway(dir: string): void {
  // Check railway CLI
  try { run("railway version", dir, true); }
  catch { console.error("Error: Railway CLI not found. Install: npm install -g @railway/cli"); process.exit(1); }

  console.log("[deploy] Deploying to Railway...");
  run("railway up", dir);

  console.log("");
  console.log("✓ Deployed to Railway!");
  console.log("  Dashboard: railway open");
  console.log("  Logs: railway logs");
}

function generateDockerfile(dir: string, port: number): void {
  const dockerfile = `FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
RUN npm run build 2>/dev/null || true
EXPOSE ${port}
ENV PORT=${port}
CMD ["npm", "start"]
`;
  fs.writeFileSync(path.join(dir, "Dockerfile"), dockerfile);

  // Also generate .dockerignore if missing
  if (!fs.existsSync(path.join(dir, ".dockerignore"))) {
    fs.writeFileSync(path.join(dir, ".dockerignore"), "node_modules\n.git\n*.db\n");
  }
}

function run(cmd: string, cwd: string, silent = false): void {
  try {
    execSync(cmd, {
      cwd,
      stdio: silent ? "pipe" : "inherit",
      timeout: 300_000,
    });
  } catch (e: any) {
    if (!silent) {
      console.error(`Command failed: ${cmd}`);
      process.exit(1);
    }
    throw e;
  }
}
