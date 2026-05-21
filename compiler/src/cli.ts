/**
 * MarrowScript compiler CLI
 */

import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { Lexer } from "./lexer";
import { Parser } from "./parser";
import { RecoveringParser } from "./parser_recovery";
import { TypeChecker } from "./typechecker";
import { Lowering } from "./lowering";
import { ConstraintSolver } from "./solver";
import { FullEmitter } from "./emit_full";
import { NakamaEmitter } from "./emit_nakama";
import { PrismaEmitter } from "./emit_prisma";
import { SqliteEmitter } from "./emit_sqlite";
import { Verifier } from "./verifier";
import { ModuleLoader } from "./module_loader";
import { Formatter } from "./formatter";
import { scaffold, ScaffoldDomain } from "./scaffold";
import { mergeWithExisting } from "./extension_manager";
import { optimize } from "./optimizer";
import { traceToTest } from "./trace_to_test";
import { reflectProject, emitMarrowStub, diffEntities, formatDiff, type ReflectedEntity } from "./reflect";
import { tuneRouter, formatTuneReport } from "./tune_router";
import { applyTuneRewrites } from "./tune_rewrite";
import { reflectProjectWithLLM, emitEnrichedStub, OpenAICompatProvider as ReflectLLMProvider } from "./reflect_llm";

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    showHelp();
    return;
  }

  const command = args[0];

  switch (command) {
    case "compile":
      requireFile(args[1], (src, res) => runCompile(src, res, args.slice(2)));
      break;
    case "lex":
      requireFile(args[1], runLex);
      break;
    case "parse":
      requireFile(args[1], runParse);
      break;
    case "ir":
      requireFile(args[1], runIR);
      break;
    case "check":
      requireFile(args[1], runCheck);
      break;
    case "fmt":
      requireFile(args[1], runFormat);
      break;
    case "watch":
      requireFile(args[1], runWatch);
      break;
    case "init":
      runInit(args.slice(1));
      break;
    case "diff":
      runDiff(args.slice(1));
      break;
    case "debug":
      requireFile(args[1], runDebug);
      break;
    case "test":
      runTest(args.slice(1));
      break;
    case "verify-determinism":
      requireFile(args[1], runVerifyDeterminism);
      break;
    case "validate":
      runValidate(args.slice(1));
      break;
    case "replay":
      runReplay(args.slice(1));
      break;
    case "trace-to-test":
      runTraceToTest(args.slice(1));
      break;
    case "reflect":
      runReflect(args.slice(1));
      break;
    case "diff-spec":
      runDiffSpec(args.slice(1));
      break;
    case "tune-router":
      runTuneRouter(args.slice(1));
      break;
    case "reflect-llm":
      runReflectLLM(args.slice(1));
      break;
    default:
      console.error(`Unknown command: ${command}`);
      showHelp();
      process.exit(1);
  }
}

function showHelp() {
  console.log("MarrowScript compiler v0.8.1");
  console.log("");
  console.log("Usage:");
  console.log("  marrowc compile <file> [--target <target>]  Compile to runnable project");
  console.log("  marrowc check <file>     Lex + parse + type check (no codegen)");
  console.log("  marrowc validate [dir]   Type-check generated output (runs tsc --noEmit)");
  console.log("  marrowc lex <file>       Show token stream");
  console.log("  marrowc parse <file>     Show AST");
  console.log("  marrowc ir <file>        Show IR (JSON)");
  console.log("  marrowc fmt <file>       Format file in place");
  console.log("  marrowc watch <file>     Recompile on change");
  console.log("  marrowc diff <old.marrow> <new.marrow> [--write <output_dir>]");
  console.log("                          Show schema migration diff (or write to migrations/_manual)");
  console.log("  marrowc replay <trace_id> [--out <dir>]");
  console.log("                          Print + dump a cognition trace from cognition_traces");
  console.log("  marrowc trace-to-test <trace.json> [--out <file>] [--no-assert-outputs]");
  console.log("                          Convert a recorded trace into a node:test regression test");
  console.log("  marrowc reflect <project_dir> [--out <file>] [--system <name>]");
  console.log("                          Infer a stub .marrow from existing TypeScript source (Phase 20)");
  console.log("  marrowc diff-spec <spec.marrow> <project_dir>");
  console.log("                          Show drift between a .marrow spec and a TypeScript project");
  console.log("  marrowc tune-router <name> --spec <file.marrow> --traces <dir>");
  console.log("                          Aggregate recorded traces and report against router policy (Phase 19 v2)");
  console.log("  marrowc reflect-llm <project_dir> [--out <file>] [--system <name>] [--endpoint <url>] [--model <name>]");
  console.log("                          Phase 20 v2: LLM-driven inference of capabilities + entities");
  console.log("");
  console.log("compile options:");
  console.log("  --target <name>        Output target (default: express)");
  console.log("                         Options:");
  console.log("                           express  - Full Express + Postgres backend (complete)");
  console.log("                           nakama   - Nakama TypeScript runtime");
  console.log("                           prisma   - Prisma schema (schema.prisma) only");
  console.log("                           sqlite   - SQLite migrations + DB client (schema only,");
  console.log("                                      no routes/auth — see output README)");
  console.log("  --no-sdk               Skip SDK generation (express target only)");
  console.log("  --no-openapi           Skip OpenAPI spec generation (express target only)");
  console.log("  --no-seed              Skip seed file generation (express target only)");
  console.log("");
  console.log("init options:");
  console.log("  marrowc init <name> --domain <name>  Scaffold from a domain template");
  console.log("  --domain <name>        Domain template (default: saas_platform)");
  console.log("                         Options: multiplayer_game, saas_platform, iot_system,");
  console.log("                                  social_network, marketplace, realtime_collaboration,");
  console.log("                                  cognitive_scaffold (LLM harness)");
  console.log("  --out <dir>            Output directory (default: current dir)");
}

function requireFile(filePath: string | undefined, action: (source: string, resolved: string) => void) {
  if (!filePath) {
    console.error("Error: No input file specified.");
    process.exit(1);
  }

  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    console.error(`Error: File not found: ${resolved}`);
    process.exit(1);
  }

  const source = fs.readFileSync(resolved, "utf-8");
  action(source, resolved);
}

// â”€â”€â”€ Lex â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function runLex(source: string) {
  try {
    const tokens = new Lexer(source).tokenize();
    console.log(JSON.stringify(tokens, null, 2));
    console.log(`\nv ${tokens.length} tokens produced.`);
  } catch (e: any) {
    console.error(`x ${e.message}`);
    process.exit(1);
  }
}

// â”€â”€â”€ Parse â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function runParse(source: string) {
  try {
    const tokens = new Lexer(source).tokenize();
    const result = new RecoveringParser(tokens).parse();
    if (result.errors.length > 0) {
      console.error(`x ${result.errors.length} parse error(s):`);
      for (const e of result.errors) console.error(`  ${e.message}`);
      if (!result.ast) process.exit(1);
    }
    console.log(JSON.stringify(result.ast, null, 2));
    console.log(`\nv Parsed ${result.ast?.systems.length || 0} system(s).`);
  } catch (e: any) {
    console.error(`x ${e.message}`);
    process.exit(1);
  }
}

// â”€â”€â”€ IR â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function runIR(source: string) {
  try {
    const tokens = new Lexer(source).tokenize();
    const ast = new Parser(tokens).parse();
    const sourceHash = createHash("sha256").update(source).digest("hex").slice(0, 16);
    const irSystems = new Lowering().lower(ast, sourceHash);
    console.log(JSON.stringify(irSystems, null, 2));
    console.log(`\nv Lowered to ${irSystems.length} IR system(s).`);
  } catch (e: any) {
    console.error(`x ${e.message}`);
    process.exit(1);
  }
}

// â”€â”€â”€ Check â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function runCheck(source: string) {
  const tokens = new Lexer(source).tokenize();
  const result = new RecoveringParser(tokens).parse();

  let totalErrors = 0;

  if (result.errors.length > 0) {
    for (const e of result.errors) {
      console.error(`  parse: ${e.message}`);
      totalErrors++;
    }
  }

  if (result.ast) {
    const typeErrors = new TypeChecker().check(result.ast);
    for (const err of typeErrors) {
      console.error(`  type:  ${err.code} at ${err.loc.line}:${err.loc.column}: ${err.message}`);
      totalErrors++;
    }
  }

  if (totalErrors === 0) {
    console.log("v Check passed (0 errors)");
  } else {
    console.log(`x ${totalErrors} error(s) found.`);
    process.exit(1);
  }
}

// â”€â”€â”€ Format â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function runFormat(source: string, resolved: string) {
  try {
    const tokens = new Lexer(source).tokenize();
    const ast = new Parser(tokens).parse();
    const formatted = new Formatter().format(ast);
    fs.writeFileSync(resolved, formatted, "utf-8");
    console.log(`v Formatted ${resolved}`);
  } catch (e: any) {
    console.error(`x ${e.message}`);
    process.exit(1);
  }
}

// â”€â”€â”€ Watch â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function runWatch(_source: string, resolved: string) {
  console.log(`Watching ${resolved}...`);

  const compile = () => {
    try {
      const fresh = fs.readFileSync(resolved, "utf-8");
      console.log(`\n[${new Date().toLocaleTimeString()}] Compiling...`);
      runCompile(fresh, resolved);
    } catch (e: any) {
      console.error(`x ${e.message}`);
    }
  };

  compile();
  fs.watchFile(resolved, { interval: 500 }, (curr, prev) => {
    if (curr.mtimeMs !== prev.mtimeMs) compile();
  });
}

// â”€â”€â”€ Init â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function runInit(args: string[]) {
  if (args.length === 0) {
    console.error("Error: bone init requires a project name.");
    console.error("Example: bone init my-project --domain saas_platform");
    process.exit(1);
  }

  const name = args[0];
  let domain: ScaffoldDomain = "saas_platform";
  let outDir = path.resolve(name);

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--domain" && args[i + 1]) {
      domain = args[i + 1] as ScaffoldDomain;
      i++;
    } else if (args[i] === "--out" && args[i + 1]) {
      outDir = path.resolve(args[i + 1]);
      i++;
    }
  }

  const validDomains: ScaffoldDomain[] = [
    "multiplayer_game", "saas_platform", "iot_system",
    "social_network", "marketplace", "realtime_collaboration",
    "cognitive_scaffold",
  ];
  if (!validDomains.includes(domain)) {
    console.error(`Error: Invalid domain '${domain}'. Valid: ${validDomains.join(", ")}`);
    process.exit(1);
  }

  const result = scaffold({ name, domain, outDir });
  console.log(`v Created ${result.created.length} file(s):`);
  for (const f of result.created) console.log(`  ${f}`);
  console.log(`\nNext steps:`);
  console.log(`  cd ${outDir}`);
  console.log(`  bone compile ${name}.marrow`);
}

// â”€â”€â”€ Compile (full pipeline) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function runCompile(source: string, resolved: string, extraArgs: string[] = []) {
  // Parse --target flag (default: express)
  let target: "express" | "nakama" | "prisma" | "sqlite" = "express";
  let noSdk = false;
  let noOpenApi = false;
  let noSeed = false;
  for (let i = 0; i < extraArgs.length; i++) {
    if (extraArgs[i] === "--target" && extraArgs[i + 1]) {
      const t = extraArgs[i + 1];
      if (t !== "express" && t !== "nakama" && t !== "prisma" && t !== "sqlite") {
        console.error(`Unknown target '${t}'. Valid targets: express, nakama, prisma, sqlite`);
        process.exit(1);
      }
      target = t;
      i++;
    } else if (extraArgs[i] === "--no-sdk") {
      noSdk = true;
    } else if (extraArgs[i] === "--no-openapi") {
      noOpenApi = true;
    } else if (extraArgs[i] === "--no-seed") {
      noSeed = true;
    }
  }

  if (target === "nakama") {
    if (noSdk || noOpenApi || noSeed) {
      console.error(`The --no-sdk, --no-openapi, and --no-seed flags only apply to --target express. Ignoring.`);
    }
    runCompileNakama(source, resolved);
    return;
  }

  if (target === "prisma") {
    if (noSdk || noOpenApi || noSeed) {
      console.error(`The --no-sdk, --no-openapi, and --no-seed flags only apply to --target express. Ignoring.`);
    }
    runCompilePrisma(source, resolved);
    return;
  }

  if (target === "sqlite") {
    if (noSdk || noOpenApi || noSeed) {
      console.error(`The --no-sdk, --no-openapi, and --no-seed flags only apply to --target express. Ignoring.`);
    }
    runCompileSqlite(source, resolved);
    return;
  }

  try {
    const tokens = new Lexer(source).tokenize();
    console.log(`  [1/7] Lexed: ${tokens.length} tokens`);

    // Use module loader to handle imports
    const loader = new ModuleLoader();
    const loadResult = loader.load(resolved);

    if (loadResult.errors.length > 0) {
      console.log(`  [2/7] Parse: ${loadResult.errors.length} error(s)`);
      for (const e of loadResult.errors.slice(0, 10)) {
        console.log(`         ${path.basename(e.file)}: ${e.error.message}`);
      }
      if (!loadResult.ast) process.exit(1);
    } else {
      const sysCount = loadResult.ast?.systems.length || 0;
      console.log(`  [2/7] Parsed: ${sysCount} system(s) from ${loadResult.loadedFiles.length} file(s)`);
    }

    const ast = loadResult.ast!;

    for (const sys of ast.systems) {
      console.log(`         System '${sys.name}':`);
      const counts: Record<string, number> = {};
      for (const d of sys.declarations) counts[d.kind] = (counts[d.kind] || 0) + 1;
      for (const [kind, count] of Object.entries(counts)) {
        console.log(`           ${kind}: ${count}`);
      }
    }

    // Stage 3: Type Check
    const checker = new TypeChecker();
    const typeErrors = checker.check(ast);
    if (typeErrors.length > 0) {
      console.log(`  [3/7] Type check: ${typeErrors.length} error(s)`);
      for (const err of typeErrors) {
        console.log(`         ${err.code} at ${err.loc.line}:${err.loc.column}: ${err.message}`);
      }
    } else {
      console.log(`  [3/7] Type check: v (0 errors)`);
    }

    // Stage 4: Lower to IR
    const sourceHash = createHash("sha256").update(source).digest("hex").slice(0, 16);
    const lowering = new Lowering();
    const irSystems = lowering.lower(ast, sourceHash);
    const totalModules = irSystems.reduce((sum, s) => sum + s.modules.length, 0);
    const totalEvents = irSystems.reduce((sum, s) => sum + s.events.length, 0);
    const totalFlows = irSystems.reduce((sum, s) => sum + s.flows.length, 0);
    console.log(`  [4/7] Lower to IR: ${totalModules} modules, ${totalEvents} events, ${totalFlows} flows`);
    for (const sys of irSystems) {
      for (const mod of sys.modules) {
        const methodCount = mod.interfaces.reduce((s, i) => s + i.methods.length, 0);
        console.log(`         ${mod.kind.padEnd(16)} ${mod.name.padEnd(24)} (${methodCount} methods, ${mod.models.length} models)`);
      }
    }

    // Stage 4.5: IR Optimization
    for (let i = 0; i < irSystems.length; i++) {
      const result = optimize(irSystems[i]);
      irSystems[i] = result.system;
      if (result.log.length > 0) {
        console.log(`  [4.5] IR optimize: ${result.modulesRemoved} modules removed, ${result.eventsDeduped} events deduped, ${result.depsRemoved} deps minimized`);
      }
    }

    // Stage 5: Constraint Solve
    const solver = new ConstraintSolver();
    let totalResolved = 0;
    for (const sys of irSystems) {
      const result = solver.solve(sys);
      sys.resolution = result.resolution;
      totalResolved += Object.keys(result.resolution).length;
      if (result.errors.length > 0) {
        console.log(`  [5/7] Constraint solve: ${result.errors.length} error(s)`);
        for (const err of result.errors) console.log(`         x ${err}`);
      } else {
        console.log(`  [5/7] Constraint solve: v (${totalResolved} resolved, ${result.assumptions.length} assumptions)`);
        for (const a of result.assumptions.slice(0, 5)) console.log(`         ${a}`);
        if (result.assumptions.length > 5) console.log(`         ... and ${result.assumptions.length - 5} more`);
      }
    }

    // Stage 6: Code Emit
    const emitter = new FullEmitter();
    const allFiles: ReturnType<typeof emitter.emit> = [];
    for (const sys of irSystems) {
      const files = emitter.emit(sys, { noSdk, noOpenApi, noSeed });
      allFiles.push(...files);
    }
    console.log(`  [6/7] Code emit: ${allFiles.length} files generated`);
    const byLang: Record<string, number> = {};
    for (const f of allFiles) byLang[f.language] = (byLang[f.language] || 0) + 1;
    for (const [lang, count] of Object.entries(byLang)) {
      console.log(`         ${lang}: ${count} file(s)`);
    }

    // Stage 7: Verify
    const verifier = new Verifier();
    const verifyResult = verifier.verify(irSystems[0], allFiles);
    const errCount = verifyResult.issues.filter(i => i.severity === "error").length;
    const warnCount = verifyResult.issues.filter(i => i.severity === "warning").length;
    if (verifyResult.passed) {
      console.log(`  [7/7] Verify: v (${allFiles.length} files, ${warnCount} warnings)`);
    } else {
      console.log(`  [7/7] Verify: FAILED (${errCount} errors, ${warnCount} warnings)`);
    }
    for (const issue of verifyResult.issues.slice(0, 10)) {
      const icon = issue.severity === "error" ? "x" : "!";
      console.log(`         ${icon} ${issue.code}: ${issue.message}`);
    }

    // Write output — merge extension point implementations from existing files
    const outputDir = path.resolve(path.dirname(resolved), "output");
    const allExtensions = irSystems.flatMap(s => s.extension_points || []);
    let extensionErrors: string[] = [];

    for (const f of allFiles) {
      const outPath = path.join(outputDir, f.path);
      const dir = path.dirname(outPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      // For extensions.ts: merge preserved implementations
      if (f.path === "src/extensions.ts" && allExtensions.length > 0) {
        const astExtensions = ast.systems.flatMap(s =>
          s.declarations.filter((d): d is any => d.kind === "ExtensionPointDecl")
        );
        const { content, validationErrors } = mergeWithExisting(f.content, outPath, astExtensions);
        for (const e of validationErrors) extensionErrors.push(e.message);
        fs.writeFileSync(outPath, content, "utf-8");
      } else {
        fs.writeFileSync(outPath, f.content, "utf-8");
      }
    }

    if (extensionErrors.length > 0) {
      console.log(`\n  Extension point errors:`);
      for (const e of extensionErrors) console.log(`    x ${e}`);
      process.exit(1);
    }

    console.log(`\nv Compilation complete. ${allFiles.length} files written to output/`);
  } catch (e: any) {
    console.error(`x ${e.message}`);
    process.exit(1);
  }
}

main();

// ─── Compile (Nakama target) ──────────────────────────────────────────────────

function runCompileNakama(source: string, resolved: string) {
  try {
    const tokens = new Lexer(source).tokenize();
    console.log(`  [1/5] Lexed: ${tokens.length} tokens`);

    const loader = new ModuleLoader();
    const loadResult = loader.load(resolved);
    if (loadResult.errors.length > 0) {
      for (const e of loadResult.errors.slice(0, 10)) {
        console.log(`         ${path.basename(e.file)}: ${e.error.message}`);
      }
      if (!loadResult.ast) process.exit(1);
    }
    const ast = loadResult.ast!;
    console.log(`  [2/5] Parsed: ${ast.systems.length} system(s)`);

    const typeErrors = new TypeChecker().check(ast);
    if (typeErrors.length > 0) {
      for (const err of typeErrors) {
        console.log(`         ${err.code} at ${err.loc.line}:${err.loc.column}: ${err.message}`);
      }
    } else {
      console.log(`  [3/5] Type check: v (0 errors)`);
    }

    const sourceHash = createHash("sha256").update(source).digest("hex").slice(0, 16);
    const irSystems = new Lowering().lower(ast, sourceHash);
    console.log(`  [4/5] Lowered to IR: ${irSystems.reduce((s, sys) => s + sys.modules.length, 0)} modules`);

    const emitter = new NakamaEmitter();
    const allFiles: ReturnType<typeof emitter.emit> = [];
    for (const sys of irSystems) {
      allFiles.push(...emitter.emit(sys));
    }
    console.log(`  [5/5] Nakama emit: ${allFiles.length} files`);

    const outputDir = path.resolve(path.dirname(resolved), "output-nakama");
    for (const f of allFiles) {
      const outPath = path.join(outputDir, f.path);
      const dir = path.dirname(outPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(outPath, f.content, "utf-8");
    }

    console.log(`\nv Nakama compilation complete. ${allFiles.length} files written to output-nakama/`);
    console.log(`\nNext steps:`);
    console.log(`  cd output-nakama && npm install && npm run build`);
    console.log(`  # Copy build/ to your Nakama runtime path`);
  } catch (e: any) {
    console.error(`x ${e.message}`);
    process.exit(1);
  }
}

// ─── Diff ─────────────────────────────────────────────────────────────────────

function runDiff(args: string[]) {
  if (args.length < 2) {
    console.error("Usage: bone diff <old.marrow> <new.marrow> [--write <dir>]");
    process.exit(1);
  }

  const [oldFile, newFile] = args;

  // Optional: --write <dir> writes the diff to a numbered migration file
  // under <dir>/migrations/_manual/ so the next `npm run migrate` picks it up.
  let writeDir: string | null = null;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === "--write" && args[i + 1]) {
      writeDir = path.resolve(args[i + 1]);
      i++;
    }
  }

  const compileToIR = (filePath: string) => {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      console.error(`File not found: ${resolved}`);
      process.exit(1);
    }
    const source = fs.readFileSync(resolved, "utf-8");
    const tokens = new Lexer(source).tokenize();
    const ast = new Parser(tokens).parse();
    const hash = createHash("sha256").update(source).digest("hex").slice(0, 16);
    return new Lowering().lower(ast, hash);
  };

  const oldIR = compileToIR(oldFile);
  const newIR = compileToIR(newFile);

  const oldModels: any[] = [];
  const newModels: any[] = [];
  for (const sys of oldIR) for (const mod of sys.modules) for (const m of mod.models) oldModels.push(m);
  for (const sys of newIR) for (const mod of sys.modules) for (const m of mod.models) newModels.push(m);

  const oldByName = new Map(oldModels.map(m => [m.name, m]));
  const newByName = new Map(newModels.map(m => [m.name, m]));
  const statements: string[] = [];

  // New tables
  for (const [name, model] of newByName) {
    if (!oldByName.has(name)) {
      statements.push(`-- NEW TABLE: ${name}`);
      statements.push(`-- Run: bone compile ${newFile} (generates full migration)`);
    }
  }

  // Removed tables
  for (const [name] of oldByName) {
    if (!newByName.has(name)) {
      const table = name.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase() + "s";
      statements.push(`-- WARNING: Table '${table}' removed from schema`);
      statements.push(`-- Manual: ALTER TABLE ${table} ... (or DROP TABLE ${table})`);
    }
  }

  // Modified tables
  for (const [name, newModel] of newByName) {
    const oldModel = oldByName.get(name);
    if (!oldModel) continue;

    const table = name.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase() + "s";
    const oldFields = new Map<string, any>(oldModel.fields.map((f: any) => [f.name, f]));
    const newFields = new Map<string, any>(newModel.fields.map((f: any) => [f.name, f]));
    const newFieldRenames = new Map<string, string>(); // newName -> oldName

    // Detect renames first so we don't double-count them as add+drop.
    for (const [fname, field] of newFields) {
      const renamedFrom = (field as any).renamed_from;
      if (renamedFrom && oldFields.has(renamedFrom) && !oldFields.has(fname)) {
        statements.push(`ALTER TABLE ${table} RENAME COLUMN ${renamedFrom} TO ${fname};`);
        newFieldRenames.set(fname, renamedFrom);
      }
    }

    const sqlTypeMap: Record<string, string> = {
      string: "VARCHAR", uint: "BIGINT", int: "BIGINT", float: "DOUBLE PRECISION",
      bool: "BOOLEAN", timestamp: "TIMESTAMPTZ", uuid: "UUID", bytes: "BYTEA", json: "JSONB",
    };

    for (const [fname, field] of newFields) {
      if (newFieldRenames.has(fname)) continue;
      if (!oldFields.has(fname)) {
        const sqlType = sqlTypeMap[(field as any).type] || "JSONB";
        statements.push(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${fname} ${sqlType};`);
      }
    }

    const renamedOldNames = new Set(newFieldRenames.values());
    for (const [fname] of oldFields) {
      if (renamedOldNames.has(fname)) continue;
      if (!newFields.has(fname)) {
        statements.push(`-- WARNING: Column '${table}.${fname}' removed`);
        statements.push(`-- Manual: ALTER TABLE ${table} DROP COLUMN ${fname};`);
      }
    }
  }

  if (statements.length === 0) {
    console.log("No schema changes detected.");
    return;
  }

  const header = [
    `-- MarrowScript schema diff: ${path.basename(oldFile)} → ${path.basename(newFile)}`,
    `-- Generated: ${new Date().toISOString()}`,
    ``,
  ];
  const body = [...header, ...statements].join("\n");

  if (!writeDir) {
    console.log(body);
    return;
  }

  // Write to <dir>/migrations/_manual/<timestamp>_<slug>.sql.
  // Compile picks this up alongside generated schemas; the schema_migrations
  // ledger ensures it only runs once.
  const manualDir = path.join(writeDir, "migrations", "_manual");
  if (!fs.existsSync(manualDir)) fs.mkdirSync(manualDir, { recursive: true });

  const existing = fs.readdirSync(manualDir).filter(f => f.endsWith(".sql"));
  const nextSeq = String(existing.length + 1).padStart(4, "0");
  const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  const slug = path.basename(newFile, path.extname(newFile)).replace(/[^a-z0-9]/gi, "_").toLowerCase();
  const fileName = `${nextSeq}_${stamp}_${slug}.sql`;
  const target = path.join(manualDir, fileName);
  fs.writeFileSync(target, body, "utf-8");
  console.log(`v Wrote migration: ${target}`);
  console.log(`  Run \`npm run migrate\` from the output dir to apply.`);
}

// ─── Debug ────────────────────────────────────────────────────────────────────

function runDebug(source: string, resolved: string) {
  try {
    const tokens = new Lexer(source).tokenize();
    const ast = new Parser(tokens).parse();
    const sourceHash = createHash("sha256").update(source).digest("hex").slice(0, 16);
    const irSystems = new Lowering().lower(ast, sourceHash);

    const { emitSourceMapFile } = require("./emit_sourcemap");
    for (const sys of irSystems) {
      const mapContent = emitSourceMapFile(sys, path.basename(resolved));
      const mapPath = path.join(path.dirname(resolved), `${sys.name}.marrow.map`);
      fs.writeFileSync(mapPath, mapContent, "utf-8");
      console.log(`v Source map written: ${mapPath}`);
      console.log(`  ${sys.modules.length} modules mapped`);
      console.log(`  Use output/src/debug.ts to get annotated runtime errors`);
    }
  } catch (e: any) {
    console.error(`x ${e.message}`);
    process.exit(1);
  }
}

// ─── Test ─────────────────────────────────────────────────────────────────────

function runTest(args: string[]) {
  const outputDir = args[0] ? path.resolve(args[0]) : path.resolve("output");
  const testFile = path.join(outputDir, "src", "tests.ts");

  if (!fs.existsSync(testFile)) {
    console.error(`No test file found at ${testFile}`);
    console.error("Run 'bone compile <file>' first to generate tests.");
    process.exit(1);
  }

  console.log(`Running MarrowScript regression tests...`);
  console.log(`Test file: ${testFile}`);
  console.log(`Target: ${process.env.TEST_BASE_URL || "http://localhost:3000"}`);
  console.log(``);

  // Run the generated test file using ts-node
  const { execSync } = require("child_process");
  try {
    execSync(`npx ts-node ${testFile}`, {
      cwd: outputDir,
      stdio: "inherit",
      env: { ...process.env },
    });
  } catch {
    process.exit(1);
  }
}

// ─── Verify Determinism ───────────────────────────────────────────────────────

function runVerifyDeterminism(source: string, resolved: string) {
  console.log("Verifying compilation determinism...");

  const compile = () => {
    const tokens = new Lexer(source).tokenize();
    const ast = new Parser(tokens).parse();
    const hash = createHash("sha256").update(source).digest("hex").slice(0, 16);
    const ir = new Lowering().lower(ast, hash);
    const emitter = new FullEmitter();
    const files: { path: string; content: string }[] = [];
    for (const sys of ir) {
      for (const f of emitter.emit(sys)) {
        files.push({ path: f.path, content: f.content });
      }
    }
    // Sort for canonical comparison
    files.sort((a, b) => a.path.localeCompare(b.path));
    return JSON.stringify(files);
  };

  const run1 = compile();
  const run2 = compile();

  if (run1 === run2) {
    const hash = createHash("sha256").update(run1).digest("hex").slice(0, 16);
    console.log(`v Deterministic. Both runs produced identical output.`);
    console.log(`  Output hash: ${hash}`);
  } else {
    // Find first divergence
    const files1: { path: string; content: string }[] = JSON.parse(run1);
    const files2: { path: string; content: string }[] = JSON.parse(run2);

    for (let i = 0; i < Math.max(files1.length, files2.length); i++) {
      const f1 = files1[i];
      const f2 = files2[i];
      if (!f1 || !f2 || f1.path !== f2.path || f1.content !== f2.content) {
        console.error(`x NON-DETERMINISTIC: First divergence at file ${i}`);
        console.error(`  Run 1: ${f1?.path || "(missing)"}`);
        console.error(`  Run 2: ${f2?.path || "(missing)"}`);
        if (f1 && f2 && f1.path === f2.path) {
          // Find first differing line
          const lines1 = f1.content.split("\n");
          const lines2 = f2.content.split("\n");
          for (let j = 0; j < Math.max(lines1.length, lines2.length); j++) {
            if (lines1[j] !== lines2[j]) {
              console.error(`  First differing line ${j + 1}:`);
              console.error(`    Run 1: ${lines1[j]}`);
              console.error(`    Run 2: ${lines2[j]}`);
              break;
            }
          }
        }
        process.exit(1);
      }
    }
  }
}

// ─── Compile (Prisma target) ──────────────────────────────────────────────────

function runCompilePrisma(source: string, resolved: string) {
  try {
    const tokens = new Lexer(source).tokenize();
    console.log(`  [1/5] Lexed: ${tokens.length} tokens`);

    const loader = new ModuleLoader();
    const loadResult = loader.load(resolved);
    if (loadResult.errors.length > 0) {
      for (const e of loadResult.errors.slice(0, 10)) {
        console.log(`         ${path.basename(e.file)}: ${e.error.message}`);
      }
      if (!loadResult.ast) process.exit(1);
    }
    const ast = loadResult.ast!;
    console.log(`  [2/5] Parsed: ${ast.systems.length} system(s)`);

    const typeErrors = new TypeChecker().check(ast);
    if (typeErrors.length > 0) {
      console.log(`  [3/5] Type check: ${typeErrors.length} error(s)`);
      for (const err of typeErrors) {
        console.log(`         ${err.code} at ${err.loc.line}:${err.loc.column}: ${err.message}`);
      }
    } else {
      console.log(`  [3/5] Type check: v (0 errors)`);
    }

    const sourceHash = createHash("sha256").update(source).digest("hex").slice(0, 16);
    const irSystems = new Lowering().lower(ast, sourceHash);
    console.log(`  [4/5] Lowered to IR: ${irSystems.reduce((s, sys) => s + sys.modules.length, 0)} modules`);

    const emitter = new PrismaEmitter();
    const allFiles: ReturnType<typeof emitter.emit> = [];
    for (const sys of irSystems) {
      allFiles.push(...emitter.emit(sys));
    }
    console.log(`  [5/5] Prisma emit: ${allFiles.length} file(s)`);

    const outputDir = path.resolve(path.dirname(resolved), "output");
    for (const f of allFiles) {
      const outPath = path.join(outputDir, f.path);
      const dir = path.dirname(outPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(outPath, f.content, "utf-8");
    }

    console.log(`\nv Prisma compilation complete. ${allFiles.length} file(s) written to output/prisma/`);
    console.log(`\nNext steps:`);
    console.log(`  cd output`);
    console.log(`  npx prisma migrate dev --name init`);
    console.log(`  npx prisma generate`);
  } catch (e: any) {
    console.error(`x ${e.message}`);
    process.exit(1);
  }
}

// ─── Validate ─────────────────────────────────────────────────────────────────

function runValidate(args: string[]) {
  let outputDir: string;
  if (args[0]) {
    outputDir = path.resolve(args[0]);
  } else {
    // Auto-detect: try output/, then output-sqlite/, then output-nakama/.
    const candidates = ["output", "output-sqlite", "output-nakama"];
    const found = candidates
      .map(c => path.resolve(c))
      .find(p => fs.existsSync(path.join(p, "tsconfig.json")));
    if (!found) {
      console.error("Error: No generated output directory found.");
      console.error("Looked for: " + candidates.join(", ") + " in " + process.cwd());
      console.error("Pass an explicit path: marrowc validate <dir>");
      process.exit(1);
    }
    outputDir = found;
    console.log(`(detected output directory: ${path.basename(outputDir)})\n`);
  }

  if (!fs.existsSync(outputDir)) {
    console.error(`Error: Output directory not found: ${outputDir}`);
    console.error("Run 'marrowc compile <file>' first to generate output.");
    process.exit(1);
  }

  const tsconfigPath = path.join(outputDir, "tsconfig.json");
  if (!fs.existsSync(tsconfigPath)) {
    console.error(`Error: No tsconfig.json found in ${outputDir}`);
    console.error("The output directory doesn't appear to be a MarrowScript-generated project.");
    process.exit(1);
  }

  // Check if node_modules exists — if not, suggest npm install
  const nodeModulesPath = path.join(outputDir, "node_modules");
  if (!fs.existsSync(nodeModulesPath)) {
    console.error(`Error: node_modules/ not found in ${outputDir}`);
    console.error("Run 'npm install' in the output directory first:");
    console.error(`  cd ${outputDir} && npm install`);
    process.exit(1);
  }

  console.log(`Validating generated TypeScript in ${outputDir}...`);
  console.log(``);

  const { execSync } = require("child_process");

  try {
    // Run tsc --noEmit to type-check without producing output
    execSync("npx tsc --noEmit", {
      cwd: outputDir,
      stdio: "pipe",
      encoding: "utf-8",
    });
    console.log(`v Validation passed. Generated code compiles cleanly.`);
  } catch (e: any) {
    // tsc returns non-zero on type errors — parse and display them
    const output = (e.stdout || "") + (e.stderr || "");
    const errorLines = output.split("\n").filter((l: string) => l.trim().length > 0);
    const errorCount = errorLines.filter((l: string) => /error TS\d+/.test(l)).length;

    console.error(`x Validation failed: ${errorCount} TypeScript error(s)\n`);

    // Show up to 20 errors for readability
    const displayLines = errorLines.slice(0, 40);
    for (const line of displayLines) {
      console.error(`  ${line}`);
    }
    if (errorLines.length > 40) {
      console.error(`  ... and ${errorLines.length - 40} more lines`);
    }

    console.error(``);
    console.error(`To see all errors, run:`);
    console.error(`  cd ${outputDir} && npx tsc --noEmit`);
    process.exit(1);
  }
}

// ─── Replay (Phase 6: cognition_traces) ───────────────────────────────────────
//
// Reads spans for a given trace_id from the cognition_traces table (or the
// in-memory backend during dev) and prints a human-readable summary. Also
// writes traces/<trace_id>.json next to the output directory so users can
// build replay drivers that swap in a fixture provider returning the recorded
// outputs.
//
// Usage:
//   marrowc replay <trace_id> [--out <output_dir>]
//
// The output directory is auto-detected from ./output if --out is omitted.
// Postgres mode uses the project's existing src/db pool; memory mode reads
// from the in-process span buffer (mostly useful when invoked from inside
// the harness application itself rather than via the CLI).

function runReplay(args: string[]) {
  if (args.length === 0) {
    console.error("Usage: marrowc replay <trace_id> [--out <output_dir>]");
    process.exit(1);
  }
  const traceId = args[0];
  let outputDir = path.resolve("output");
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--out" && args[i + 1]) {
      outputDir = path.resolve(args[i + 1]);
      i++;
    }
  }
  const tracesModule = path.join(outputDir, "src", "cognition", "traces.ts");
  if (!fs.existsSync(tracesModule)) {
    console.error(`No cognition traces module at ${tracesModule}`);
    console.error(`Run 'marrowc compile <file>' first and ensure the system declares prompts.`);
    process.exit(1);
  }
  // Spawn ts-node inside the output directory so the lazy require("../db") from
  // src/cognition/traces.ts resolves correctly when LLM_TRACES_BACKEND=pg.
  const driverSrc = `
import { loadTrace } from "./src/cognition/traces";
import * as fs from "fs";
import * as path from "path";

(async () => {
  const trace_id = ${JSON.stringify(traceId)};
  const spans = await loadTrace(trace_id);
  if (spans.length === 0) {
    console.error("No spans found for trace", trace_id);
    console.error("Hint: in-memory backend only retains spans within the same process.");
    process.exit(2);
  }
  // Human summary.
  console.log("Trace " + trace_id + " — " + spans.length + " span(s)");
  console.log("=".repeat(72));
  let totalTokens = 0;
  let totalCost = 0;
  let cacheHits = 0;
  for (const s of spans) {
    const tokens = (s.prompt_tokens ?? 0) + (s.completion_tokens ?? 0);
    totalTokens += tokens;
    totalCost += s.cost_usd ?? 0;
    if (s.cache_hit) cacheHits++;
    const line = [
      new Date(s.started_at).toISOString(),
      "[" + s.kind + "]",
      s.workflow + "." + s.step,
      "→ " + s.status,
      s.model ? "(" + s.model + ")" : "",
      tokens > 0 ? tokens + "tok" : "",
      s.latency_ms + "ms",
      s.cache_hit ? "[cache]" : "",
    ].filter(Boolean).join(" ");
    console.log("  " + line);
    if (s.error_code) console.log("    error: " + s.error_code);
    if (s.metadata && Object.keys(s.metadata).length > 0) {
      console.log("    metadata: " + JSON.stringify(s.metadata).slice(0, 200));
    }
  }
  console.log("=".repeat(72));
  console.log("Total tokens: " + totalTokens + ", cost: $" + totalCost.toFixed(6) + ", cache hits: " + cacheHits);

  // Write a JSON fixture next to the output dir so users can build replay drivers.
  const dir = path.resolve("traces");
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, trace_id + ".json");
  fs.writeFileSync(out, JSON.stringify(spans, null, 2), "utf-8");
  console.log("Wrote fixture to " + path.relative(process.cwd(), out));
})().catch(err => {
  console.error("Replay failed:", err && err.message ? err.message : err);
  process.exit(1);
});
`;
  const driverPath = path.join(outputDir, ".bonec_replay.ts");
  fs.writeFileSync(driverPath, driverSrc, "utf-8");
  try {
    require("child_process").execSync(`npx --no-install ts-node --transpile-only ${driverPath}`, {
      cwd: outputDir,
      stdio: "inherit",
      env: { ...process.env },
    });
  } catch {
    process.exit(1);
  } finally {
    try { fs.unlinkSync(driverPath); } catch { /* best effort */ }
  }
}

// ─── Trace → regression test (Phase 22) ──────────────────────────────────────
//
// Reads a JSON trace dumped by `marrowc replay <trace_id>` and emits a
// node:test regression test that pins every recorded prompt input → output
// mapping. Catches "the surrounding code changed but the LLM behavior
// stayed the same" regressions cheaply.
//
// Usage:
//   marrowc trace-to-test <trace.json> [--out <file>] [--no-assert-outputs]
//
// When --out is omitted, the test is written next to the trace as
// <trace>.test.ts. When --no-assert-outputs is set, only the call sequence
// is verified — useful when outputs are non-deterministic and you only
// care about the prompt count / call shape.

function runTraceToTest(args: string[]) {
  if (args.length === 0) {
    console.error("Usage: marrowc trace-to-test <trace.json> [--out <file>] [--no-assert-outputs]");
    process.exit(1);
  }
  const tracePath = path.resolve(args[0]);
  if (!fs.existsSync(tracePath)) {
    console.error(`Trace file not found: ${tracePath}`);
    process.exit(1);
  }
  let outPath = tracePath.replace(/\.json$/i, "") + ".test.ts";
  let assertOutputs = true;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--out" && args[i + 1]) { outPath = path.resolve(args[i + 1]); i++; }
    else if (args[i] === "--no-assert-outputs") { assertOutputs = false; }
  }
  let raw: string;
  try { raw = fs.readFileSync(tracePath, "utf-8"); }
  catch (e) { console.error(`Failed to read trace: ${(e as Error).message}`); process.exit(1); }
  let spans: unknown;
  try { spans = JSON.parse(raw); }
  catch (e) { console.error(`Trace is not valid JSON: ${(e as Error).message}`); process.exit(1); }
  if (!Array.isArray(spans)) {
    console.error(`Trace must be a JSON array of spans (got ${typeof spans})`);
    process.exit(1);
  }
  // Trace id: prefer the explicit field on the first span; fall back to the file name.
  const first = (spans[0] ?? {}) as { trace_id?: string };
  const traceId = first.trace_id || path.basename(tracePath).replace(/\.json$/i, "");
  const test = traceToTest(spans as Parameters<typeof traceToTest>[0], { traceId, assertOutputs });
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, test, "utf-8");
  } catch (e) {
    console.error(`Failed to write test: ${(e as Error).message}`);
    process.exit(1);
  }
  const promptCallCount = (spans as { kind?: string }[]).filter(s => s.kind === "prompt_call").length;
  console.log(`v Wrote regression test: ${path.relative(process.cwd(), outPath)}`);
  console.log(`  Trace id: ${traceId}`);
  console.log(`  Prompt calls replayed: ${promptCallCount}`);
  console.log(`  Run with: npx --no-install ts-node --transpile-only --test ${path.relative(process.cwd(), outPath)}`);
}

// ─── Reflect: TypeScript → .marrow stub (Phase 20) ────────────────────────────
//
// Walks a project directory, finds entity-shaped class/interface declarations
// (those with an `id` member), and emits a stub .marrow source. Intended as
// an adoption helper for existing TypeScript codebases — review the output
// before merging.
//
// v1 is AST-only — capabilities, state machines, and audit boundaries need
// LLM-driven inference (future work).

function runReflect(args: string[]) {
  if (args.length === 0) {
    console.error("Usage: marrowc reflect <project_dir> [--out <file>] [--system <name>]");
    process.exit(1);
  }
  const root = path.resolve(args[0]);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    console.error(`Not a directory: ${root}`);
    process.exit(1);
  }
  let outPath: string | null = null;
  let systemName = path.basename(root);
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--out" && args[i + 1]) { outPath = path.resolve(args[i + 1]); i++; }
    else if (args[i] === "--system" && args[i + 1]) { systemName = args[i + 1]; i++; }
  }
  // Sanitise the system name to a valid identifier.
  systemName = systemName.replace(/[^A-Za-z0-9_]/g, "_");
  if (/^[0-9]/.test(systemName)) systemName = "S_" + systemName;

  let result;
  try { result = reflectProject(root); }
  catch (e) { console.error(`Reflect failed: ${(e as Error).message}`); process.exit(1); return; }

  const stub = emitMarrowStub(systemName, result);
  if (outPath) {
    try {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, stub, "utf-8");
      console.log(`v Wrote stub: ${path.relative(process.cwd(), outPath)}`);
    } catch (e) {
      console.error(`Failed to write stub: ${(e as Error).message}`);
      process.exit(1);
    }
  } else {
    process.stdout.write(stub);
  }
  console.log(`  Entities: ${result.entities.length}`);
  if (result.unparsed.length > 0) console.log(`  Unparsed: ${result.unparsed.length} file(s)`);
}

// ─── Diff-spec: spec ↔ source drift (Phase 20) ────────────────────────────────
//
// Compares a .marrow spec's entity declarations against the entity shapes
// inferred from a TypeScript project. Reports per-entity additions /
// removals / type changes. Useful as a CI check: PRs that change the
// schema in code without updating the spec become visible.

function runDiffSpec(args: string[]) {
  if (args.length < 2) {
    console.error("Usage: marrowc diff-spec <spec.marrow> <project_dir>");
    process.exit(1);
  }
  const specPath = path.resolve(args[0]);
  const projectDir = path.resolve(args[1]);
  if (!fs.existsSync(specPath)) { console.error(`Spec not found: ${specPath}`); process.exit(1); }
  if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
    console.error(`Not a directory: ${projectDir}`); process.exit(1);
  }
  // Load the spec via the existing pipeline.
  const source = fs.readFileSync(specPath, "utf-8");
  const tokens = new Lexer(source).tokenize();
  const ast = new Parser(tokens).parse();
  const errs = new TypeChecker().check(ast);
  if (errs.length > 0) {
    console.error("Spec has type errors:");
    for (const e of errs.slice(0, 10)) console.error(`  ${e.code}: ${e.message}`);
    process.exit(1);
  }
  const sourceHash = createHash("sha256").update(source).digest("hex").slice(0, 16);
  const irSystems = new Lowering().lower(ast, sourceHash);
  // Translate IR entities into ReflectedEntity[] using the same projection
  // shape so diffEntities can compare cleanly.
  const specEntities: ReflectedEntity[] = [];
  for (const sys of irSystems) {
    for (const mod of sys.modules) {
      // api_service modules wrap entities. The first model in each is the entity.
      if (mod.kind !== "api_service") continue;
      const m = mod.models[0];
      if (!m) continue;
      // Skip ontology fields (id / created_at / updated_at) so the diff
      // matches what reflect emits (the stub omits them).
      const fields = m.fields.filter(f => f.name !== "id" && f.name !== "created_at" && f.name !== "updated_at");
      specEntities.push({
        name: m.name,
        source_file: specPath,
        fields: fields.map(f => ({ name: f.name, type: f.type, optional: f.nullable })),
      });
    }
  }
  // Sort fields alphabetically (same as reflect does) for consistent diff output.
  for (const e of specEntities) e.fields.sort((a, b) => a.name.localeCompare(b.name));
  specEntities.sort((a, b) => a.name.localeCompare(b.name));

  const sourceResult = reflectProject(projectDir);
  // Strip ontology fields from source-side too so the diff is symmetric.
  for (const e of sourceResult.entities) {
    e.fields = e.fields.filter(f => f.name !== "id" && f.name !== "created_at" && f.name !== "updated_at");
  }

  const diff = diffEntities(specEntities, sourceResult.entities);
  console.log(formatDiff(diff));

  // Exit non-zero when there's drift so CI can fail the PR.
  if (diff.source_only.length > 0 || diff.spec_only.length > 0 || diff.field_diffs.length > 0) {
    process.exit(1);
  }
}

// ─── Tune-router: aggregate traces against router policy (Phase 19 v2) ───────
//
// Reads recorded cognition trace dumps (the JSON shape `marrowc replay`
// writes) and reports per-tier metrics for a named router. When the router
// declares a policy: clause, the tuner checks each constraint against the
// observed metrics and surfaces suggestions when constraints fail.
//
// Read-only — the .marrow source stays the source of truth. Suggestions are
// printed to stdout; the human edits the spec.
//
// Usage:
//   marrowc tune-router <name> --spec <file.marrow> --traces <dir>
//   marrowc tune-router <name> --spec <file.marrow> --traces <dir> --json

function runTuneRouter(args: string[]) {
  if (args.length === 0) {
    console.error("Usage: marrowc tune-router <name> --spec <file.marrow> --traces <dir> [--json] [--apply]");
    process.exit(1);
  }
  const routerName = args[0];
  let specPath: string | null = null;
  let tracesDir: string | null = null;
  let asJson = false;
  let apply = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--spec" && args[i + 1]) { specPath = path.resolve(args[i + 1]); i++; }
    else if (args[i] === "--traces" && args[i + 1]) { tracesDir = path.resolve(args[i + 1]); i++; }
    else if (args[i] === "--json") asJson = true;
    else if (args[i] === "--apply") apply = true;
  }
  if (!specPath || !tracesDir) {
    console.error("Both --spec and --traces are required.");
    process.exit(1);
    return;
  }
  if (!fs.existsSync(specPath)) { console.error(`Spec not found: ${specPath}`); process.exit(1); return; }
  if (!fs.existsSync(tracesDir) || !fs.statSync(tracesDir).isDirectory()) {
    console.error(`Traces dir not found: ${tracesDir}`); process.exit(1); return;
  }

  // Load + lower the spec to find the router IR.
  const source = fs.readFileSync(specPath, "utf-8");
  const tokens = new Lexer(source).tokenize();
  const ast = new Parser(tokens).parse();
  const errs = new TypeChecker().check(ast);
  if (errs.length > 0) {
    console.error("Spec has type errors:");
    for (const e of errs.slice(0, 10)) console.error(`  ${e.code}: ${e.message}`);
    process.exit(1);
  }
  const sourceHash = createHash("sha256").update(source).digest("hex").slice(0, 16);
  const irSystems = new Lowering().lower(ast, sourceHash);
  let router = null;
  for (const sys of irSystems) {
    const found = sys.routers.find(r => r.name === routerName);
    if (found) { router = found; break; }
  }
  if (!router) {
    console.error(`Router '${routerName}' not found in ${path.basename(specPath)}`);
    process.exit(1);
    return;
  }

  // Load every JSON file in the traces dir. The `marrowc replay` command
  // writes one file per trace_id; the tuner aggregates across all of them.
  const allSpans: Parameters<typeof tuneRouter>[1] = [];
  const entries = fs.readdirSync(tracesDir)
    .filter(f => f.endsWith(".json"))
    .sort(); // deterministic order
  for (const f of entries) {
    let raw: string;
    try { raw = fs.readFileSync(path.join(tracesDir, f), "utf-8"); } catch { continue; }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { continue; }
    if (Array.isArray(parsed)) {
      for (const s of parsed) allSpans.push(s as Parameters<typeof tuneRouter>[1][0]);
    }
  }

  const report = tuneRouter(router, allSpans);
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatTuneReport(report));
  }
  // --apply: auto-rewrite safe threshold edits into the spec file.
  if (apply && specPath) {
    const rewrite = applyTuneRewrites(specPath, router, report);
    if (rewrite.written) {
      console.log("");
      console.log("Auto-applied edits:");
      for (const e of rewrite.applied) {
        console.log(`  v ${e.tier}: max ${e.oldMax} → ${e.newMax} (line ${e.line})`);
      }
      if (rewrite.skipped.length > 0) {
        console.log("Skipped:");
        for (const s of rewrite.skipped) console.log(`  - ${s}`);
      }
      console.log(`Backup written to: ${specPath}.bak`);
    } else {
      console.log("\n--apply: no safe edits to apply.");
      if (rewrite.skipped.length > 0) {
        for (const s of rewrite.skipped) console.log(`  - ${s}`);
      }
    }
  }
  // Exit non-zero when any policy constraint fails so CI can surface drift.
  const anyFail = report.constraints.some(c => c.observed.some(o => !o.passes));
  process.exit(anyFail ? 1 : 0);
}

// ─── Reflect-LLM: Phase 20 v2 — LLM-driven inference ─────────────────────────
//
// Walks a TypeScript project, finds entity-shaped declarations via static
// analysis (Phase 20 v1), then prompts an LLM through a closed tool list
// to infer capabilities operating on those entities. Emits an enriched
// .marrow stub combining both.
//
// Provider defaults to LM Studio at http://127.0.0.1:1234/v1; override via
// --endpoint or LLM_REFLECT_ENDPOINT. Model defaults to gpt-4o-mini;
// override via --model or LLM_REFLECT_MODEL.

function runReflectLLM(args: string[]) {
  if (args.length === 0) {
    console.error("Usage: marrowc reflect-llm <project_dir> [--out <file>] [--system <name>] [--endpoint <url>] [--model <name>] [--max-tool-calls <n>]");
    process.exit(1);
  }
  const root = path.resolve(args[0]);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    console.error(`Not a directory: ${root}`);
    process.exit(1);
  }
  let outPath: string | null = null;
  let systemName = path.basename(root);
  let endpoint: string | undefined;
  let model: string | undefined;
  let maxToolCalls: number | undefined;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--out" && args[i + 1]) { outPath = path.resolve(args[i + 1]); i++; }
    else if (args[i] === "--system" && args[i + 1]) { systemName = args[i + 1]; i++; }
    else if (args[i] === "--endpoint" && args[i + 1]) { endpoint = args[i + 1]; i++; }
    else if (args[i] === "--model" && args[i + 1]) { model = args[i + 1]; i++; }
    else if (args[i] === "--max-tool-calls" && args[i + 1]) { maxToolCalls = parseInt(args[i + 1], 10); i++; }
  }
  systemName = systemName.replace(/[^A-Za-z0-9_]/g, "_");
  if (/^[0-9]/.test(systemName)) systemName = "S_" + systemName;

  const provider = endpoint ? new ReflectLLMProvider(endpoint) : undefined;
  console.log(`Phase 20 v2: walking ${path.relative(process.cwd(), root)} with model=${model ?? "default"}…`);
  reflectProjectWithLLM({
    root,
    provider,
    model,
    maxToolCalls,
  }).then(({ static_result, llm_result, sm_result }) => {
    const stub = emitEnrichedStub(systemName, static_result, llm_result, sm_result);
    if (outPath) {
      try {
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, stub, "utf-8");
        console.log(`v Wrote enriched stub: ${path.relative(process.cwd(), outPath)}`);
      } catch (e) {
        console.error(`Failed to write stub: ${(e as Error).message}`);
        process.exit(1);
      }
    } else {
      process.stdout.write(stub);
    }
    console.log(`  Entities: ${static_result.entities.length}`);
    console.log(`  Inferred capabilities: ${llm_result.capabilities.length}`);
    console.log(`  Inferred state machines: ${sm_result.state_machines.length}`);
    console.log(`  Tool calls: ${llm_result.trace.tool_calls + sm_result.trace.tool_calls}, tokens: ${llm_result.trace.total_prompt_tokens + llm_result.trace.total_completion_tokens + sm_result.trace.total_prompt_tokens + sm_result.trace.total_completion_tokens}${llm_result.trace.budget_exceeded || sm_result.trace.budget_exceeded ? " (BUDGET EXCEEDED)" : ""}`);
  }).catch(err => {
    console.error(`reflect-llm failed: ${err && err.message ? err.message : String(err)}`);
    process.exit(1);
  });
}

// ─── Compile (SQLite target) ──────────────────────────────────────────────────

function runCompileSqlite(source: string, resolved: string) {
  try {
    const tokens = new Lexer(source).tokenize();
    console.log(`  [1/7] Lexed: ${tokens.length} tokens`);

    const loader = new ModuleLoader();
    const loadResult = loader.load(resolved);
    if (loadResult.errors.length > 0) {
      for (const e of loadResult.errors.slice(0, 10)) {
        console.log(`         ${path.basename(e.file)}: ${e.error.message}`);
      }
      if (!loadResult.ast) process.exit(1);
    }
    const ast = loadResult.ast!;
    console.log(`  [2/7] Parsed: ${ast.systems.length} system(s)`);

    const typeErrors = new TypeChecker().check(ast);
    if (typeErrors.length > 0) {
      console.log(`  [3/7] Type check: ${typeErrors.length} error(s)`);
      for (const err of typeErrors) {
        console.log(`         ${err.code} at ${err.loc.line}:${err.loc.column}: ${err.message}`);
      }
    } else {
      console.log(`  [3/7] Type check: v (0 errors)`);
    }

    const sourceHash = createHash("sha256").update(source).digest("hex").slice(0, 16);
    const lowering = new Lowering();
    const irSystems = lowering.lower(ast, sourceHash);
    console.log(`  [4/7] Lowered to IR: ${irSystems.reduce((s, sys) => s + sys.modules.length, 0)} modules`);

    // Run optimize + solver so the FullEmitter produces complete output.
    for (let i = 0; i < irSystems.length; i++) {
      const result = optimize(irSystems[i]);
      irSystems[i] = result.system;
    }
    const solver = new ConstraintSolver();
    for (const sys of irSystems) {
      const result = solver.solve(sys);
      sys.resolution = result.resolution;
    }
    console.log(`  [5/7] Optimize + solve: v`);

    const emitter = new SqliteEmitter();
    const allFiles: ReturnType<typeof emitter.emit> = [];
    for (const sys of irSystems) {
      allFiles.push(...emitter.emit(sys));
    }
    console.log(`  [6/7] SQLite emit: ${allFiles.length} file(s)`);

    const outputDir = path.resolve(path.dirname(resolved), "output-sqlite");
    for (const f of allFiles) {
      const outPath = path.join(outputDir, f.path);
      const dir = path.dirname(outPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(outPath, f.content, "utf-8");
    }
    console.log(`  [7/7] Wrote ${allFiles.length} files to ${path.basename(outputDir)}/`);

    console.log(`\nv SQLite compilation complete.`);
    console.log(`\nNext steps:`);
    console.log(`  cd output-sqlite`);
    console.log(`  npm install`);
    console.log(`  npm run migrate`);
    console.log(`  npm run dev`);
    console.log(`  # → http://localhost:3000`);
  } catch (e: any) {
    console.error(`x ${e.message}`);
    process.exit(1);
  }
}
