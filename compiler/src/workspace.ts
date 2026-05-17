/**
 * MarrowScript Workspace — Multi-system composition (Phase 28)
 *
 * A workspace.marrow file wires multiple systems together:
 *
 *   workspace MyPlatform {
 *     systems: [
 *       "./auth/auth.marrow" as AuthService,
 *       "./payments/payments.marrow" as PaymentService,
 *       "./notifications/notify.marrow" as NotifyService,
 *     ]
 *
 *     // Cross-service event routing
 *     route PaymentService.PaymentCompleted -> NotifyService.send_receipt
 *     route AuthService.UserCreated -> PaymentService.create_customer
 *
 *     // Shared types (available to all systems)
 *     shared: "./shared/types.marrow"
 *   }
 *
 * Behavior:
 *   1. Loads each system from its .marrow file
 *   2. Type-checks cross-service references (events → capabilities)
 *   3. Generates inter-service communication code (HTTP calls or event bus)
 *   4. Each system compiles independently but with shared types available
 *   5. Generates a docker-compose.yaml / k8s manifests for the full workspace
 */

import * as fs from "fs";
import * as path from "path";
import { Lexer } from "./lexer";
import { Parser } from "./parser";
import { RecoveringParser } from "./parser_recovery";
import { ModuleLoader } from "./module_loader";
import * as AST from "./ast";
import * as IR from "./ir";

export interface WorkspaceConfig {
  name: string;
  systems: WorkspaceSystem[];
  routes: WorkspaceRoute[];
  shared: string | null;
}

export interface WorkspaceSystem {
  path: string;
  alias: string;
  resolvedPath: string;
}

export interface WorkspaceRoute {
  sourceSystem: string;
  sourceEvent: string;
  targetSystem: string;
  targetCapability: string;
}

export interface WorkspaceResult {
  config: WorkspaceConfig;
  systems: { alias: string; ast: AST.ProgramNode; ir: IR.IRSystem }[];
  errors: string[];
  warnings: string[];
}

/**
 * Parse a workspace.marrow file.
 * Returns the workspace configuration without compiling individual systems.
 */
export function parseWorkspace(workspaceFile: string): WorkspaceConfig | null {
  const source = fs.readFileSync(workspaceFile, "utf-8");
  const dir = path.dirname(path.resolve(workspaceFile));

  // Simple regex-based parser for workspace syntax
  // (workspace files are much simpler than system files)
  const nameMatch = source.match(/workspace\s+(\w+)\s*\{/);
  if (!nameMatch) return null;

  const config: WorkspaceConfig = {
    name: nameMatch[1],
    systems: [],
    routes: [],
    shared: null,
  };

  // Parse systems: [ "path" as Alias, ... ]
  const systemsMatch = source.match(/systems\s*:\s*\[([\s\S]*?)\]/);
  if (systemsMatch) {
    const entries = systemsMatch[1].matchAll(/"([^"]+)"\s+as\s+(\w+)/g);
    for (const entry of entries) {
      config.systems.push({
        path: entry[1],
        alias: entry[2],
        resolvedPath: path.resolve(dir, entry[1]),
      });
    }
  }

  // Parse routes: route Source.Event -> Target.capability
  const routeMatches = source.matchAll(/route\s+(\w+)\.(\w+)\s*->\s*(\w+)\.(\w+)/g);
  for (const m of routeMatches) {
    config.routes.push({
      sourceSystem: m[1],
      sourceEvent: m[2],
      targetSystem: m[3],
      targetCapability: m[4],
    });
  }

  // Parse shared: "path"
  const sharedMatch = source.match(/shared\s*:\s*"([^"]+)"/);
  if (sharedMatch) {
    config.shared = path.resolve(dir, sharedMatch[1]);
  }

  return config;
}

/**
 * Load and validate all systems in a workspace.
 * Does not compile — just loads ASTs and checks cross-references.
 */
export function loadWorkspace(workspaceFile: string): WorkspaceResult {
  const config = parseWorkspace(workspaceFile);
  if (!config) {
    return { config: { name: "", systems: [], routes: [], shared: null }, systems: [], errors: ["Invalid workspace file"], warnings: [] };
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  const systems: WorkspaceResult["systems"] = [];

  // Load shared types first
  let sharedDecls: AST.DeclarationNode[] = [];
  if (config.shared && fs.existsSync(config.shared)) {
    const loader = new ModuleLoader();
    const result = loader.load(config.shared);
    if (result.ast) {
      for (const sys of result.ast.systems) {
        sharedDecls.push(...sys.declarations);
      }
    }
    for (const err of result.errors) {
      errors.push(`[shared] ${err.file}: ${err.error.message}`);
    }
  }

  // Load each system
  for (const sysDef of config.systems) {
    if (!fs.existsSync(sysDef.resolvedPath)) {
      errors.push(`System file not found: ${sysDef.path} (resolved: ${sysDef.resolvedPath})`);
      continue;
    }

    const loader = new ModuleLoader();
    const result = loader.load(sysDef.resolvedPath);

    if (!result.ast || result.ast.systems.length === 0) {
      errors.push(`Failed to load system '${sysDef.alias}' from ${sysDef.path}`);
      for (const err of result.errors) {
        errors.push(`  [${sysDef.alias}] ${err.error.message}`);
      }
      continue;
    }

    // Inject shared declarations into each system
    if (sharedDecls.length > 0) {
      result.ast.systems = result.ast.systems.map(sys => ({
        ...sys,
        declarations: [...sharedDecls, ...sys.declarations],
      }));
    }

    // Placeholder IR (actual lowering happens at compile time)
    systems.push({
      alias: sysDef.alias,
      ast: result.ast,
      ir: null as any, // filled during compile
    });
  }

  // Validate routes — check that referenced events and capabilities exist
  for (const route of config.routes) {
    const source = systems.find(s => s.alias === route.sourceSystem);
    const target = systems.find(s => s.alias === route.targetSystem);

    if (!source) {
      errors.push(`Route references unknown system: ${route.sourceSystem}`);
      continue;
    }
    if (!target) {
      errors.push(`Route references unknown system: ${route.targetSystem}`);
      continue;
    }

    // Check event exists in source
    const sourceDecls = source.ast.systems.flatMap(s => s.declarations);
    const eventExists = sourceDecls.some(d => d.kind === "EventDecl" && d.name === route.sourceEvent);
    if (!eventExists) {
      warnings.push(`Route: ${route.sourceSystem}.${route.sourceEvent} — event not found in source system`);
    }

    // Check capability exists in target
    const targetDecls = target.ast.systems.flatMap(s => s.declarations);
    const capExists = targetDecls.some(d => d.kind === "CapabilityDecl" && d.name === route.targetCapability);
    if (!capExists) {
      warnings.push(`Route: ${route.targetSystem}.${route.targetCapability} — capability not found in target system`);
    }
  }

  return { config, systems, errors, warnings };
}

/**
 * Generate inter-service communication code for a workspace.
 * Creates event subscribers that call cross-service HTTP endpoints.
 */
export function generateWorkspaceGlue(workspace: WorkspaceResult): string {
  const lines: string[] = [];
  lines.push("// Generated by MarrowScript workspace compiler. DO NOT EDIT.");
  lines.push("// Inter-service event routing for workspace: " + workspace.config.name);
  lines.push("");
  lines.push("import { eventBus } from \"./events\";");
  lines.push("");

  for (const route of workspace.config.routes) {
    const source = workspace.systems.find(s => s.alias === route.sourceSystem);
    const target = workspace.systems.find(s => s.alias === route.targetSystem);
    if (!source || !target) continue;

    lines.push(`// ${route.sourceSystem}.${route.sourceEvent} -> ${route.targetSystem}.${route.targetCapability}`);
    lines.push(`eventBus.subscribe("${route.sourceEvent}", async (payload) => {`);
    lines.push(`  const targetUrl = process.env.${route.targetSystem.toUpperCase()}_URL || "http://localhost:3000";`);
    lines.push(`  try {`);
    lines.push(`    await fetch(\`\${targetUrl}/${route.targetCapability}\`, {`);
    lines.push(`      method: "POST",`);
    lines.push(`      headers: { "Content-Type": "application/json" },`);
    lines.push(`      body: JSON.stringify(payload),`);
    lines.push(`    });`);
    lines.push(`  } catch (e: any) {`);
    lines.push(`    console.error("Cross-service call failed:", "${route.targetSystem}.${route.targetCapability}", e.message);`);
    lines.push(`  }`);
    lines.push(`});`);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Generate docker-compose.yaml for a workspace.
 */
export function generateWorkspaceDocker(workspace: WorkspaceResult): string {
  const lines: string[] = [];
  lines.push("# Generated by MarrowScript workspace compiler. DO NOT EDIT.");
  lines.push(`# Workspace: ${workspace.config.name}`);
  lines.push("");
  lines.push("services:");

  for (const sys of workspace.systems) {
    const alias = sys.alias.toLowerCase().replace(/[^a-z0-9]/g, "-");
    const port = 3000 + workspace.systems.indexOf(sys);
    lines.push(`  ${alias}:`);
    lines.push(`    build: ./${sys.alias.toLowerCase()}`);
    lines.push(`    ports:`);
    lines.push(`      - "${port}:3000"`);
    lines.push(`    environment:`);

    // Add URLs for other services
    for (const other of workspace.systems) {
      if (other.alias === sys.alias) continue;
      const otherAlias = other.alias.toLowerCase().replace(/[^a-z0-9]/g, "-");
      lines.push(`      ${other.alias.toUpperCase()}_URL: http://${otherAlias}:3000`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
