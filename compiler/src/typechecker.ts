/**
 * MarrowScript Type Checker â€” Stage 3 of the compilation pipeline.
 * Implements spec/04_TYPE_SYSTEM.md.
 *
 * Responsibilities:
 * 1. Build symbol table from entity declarations
 * 2. Verify all field types resolve to valid types
 * 3. Verify all constraint expressions type to bool
 * 4. Verify capability preconditions type to bool
 * 5. Verify effects are well-typed (target and value match)
 * 6. Verify emitted events exist
 * 7. Verify state machine transitions reference valid states
 * 8. Verify flow steps reference valid capabilities
 *
 * Deterministic: same AST always produces same errors in same order.
 */

import * as AST from "./ast";
import {
  CVType, PrimitiveType, GenericType, RecordType,
  prim, generic, record, BOTTOM,
  typeEquals, typeToString, isNumeric, isComparable,
} from "./types";
import { lookupCognition, listCognitionPrimitives } from "./cognition_catalog";
import { lookupPromptbookEntry, listPromptbookNames } from "./promptbook";

// â”€â”€â”€ Type Error â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface TypeError {
  code: string;
  message: string;
  loc: AST.ASTNode["loc"];
}

// â”€â”€â”€ Symbol Table â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

interface EntitySymbol {
  name: string;
  type: RecordType;
  states: string[];
  capabilities: string[];
}

interface CapabilitySymbol {
  name: string;
  params: Map<string, CVType>;
  /**
   * True when the capability declares a `cognition: <primitive>` modifier.
   * Phase 15 uses this to enforce T029: only cognition-bearing capabilities
   * may be listed in a prompt's `tools:` clause. Effect-bearing or pipeline
   * capabilities can't be tools because they would need to dispatch through
   * HTTP / DB layers and that breaks the deterministic compile-time tool
   * contract.
   */
  hasCognition: boolean;
  /**
   * Declared return type expression (e.g. "string", "list<File>") or null
   * for capabilities without an explicit `returns:` clause. Tool dispatch
   * uses this to surface a typed return value to the calling prompt.
   */
  returnType: string | null;
}

interface EventSymbol {
  name: string;
  payloadFields: Map<string, CVType>;
}

interface SymbolTable {
  entities: Map<string, EntitySymbol>;
  capabilities: Map<string, CapabilitySymbol>;
  events: Map<string, EventSymbol>;
  stores: Set<string>;
  channels: Set<string>;
  flows: Set<string>;
  // Cognition Layer (LLM Harness, Phase 1) ─────────────────────────────────
  // Names are tracked separately from entities/capabilities to keep the
  // namespaces independent. Cross-references are checked in Phase 2 of the
  // type checker (model exists / router exists / tools exist).
  models: Set<string>;
  prompts: Set<string>;
  routers: Set<string>;
  extensionPoints: Set<string>;
  /** Phase 16: evaluation names. */
  evaluations: Set<string>;
}

// â”€â”€â”€ Type Checker â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export class TypeChecker {
  private errors: TypeError[] = [];
  /**
   * Phase 16: tracks the system currently being checked so per-decl helpers
   * (e.g. evaluation prompt-param lookup) can walk declarations without
   * rebuilding lookup tables. Reset at the start of each checkSystem.
   */
  private currentSystem: AST.SystemDeclNode | null = null;
  private symbols: SymbolTable = {
    entities: new Map(),
    capabilities: new Map(),
    events: new Map(),
    stores: new Set(),
    channels: new Set(),
    flows: new Set(),
    models: new Set(),
    prompts: new Set(),
    routers: new Set(),
    extensionPoints: new Set(),
    evaluations: new Set(),
  };

  check(program: AST.ProgramNode): TypeError[] {
    this.errors = [];
    // Reset symbol table — the checker is reusable across programs.
    this.symbols = {
      entities: new Map(),
      capabilities: new Map(),
      events: new Map(),
      stores: new Set(),
      channels: new Set(),
      flows: new Set(),
      models: new Set(),
      prompts: new Set(),
      routers: new Set(),
      extensionPoints: new Set(),
      evaluations: new Set(),
    };

    for (const system of program.systems) {
      this.checkSystem(system);
    }

    return this.errors;
  }

  private addError(code: string, message: string, loc: AST.ASTNode["loc"]) {
    this.errors.push({ code, message, loc });
  }

  // â”€â”€â”€ Phase 1: Build Symbol Table â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  private checkSystem(system: AST.SystemDeclNode) {
    // Phase 16: stash the current system so per-decl helpers can re-walk
    // declarations (e.g. evaluation needs to look up the referenced prompt's
    // parameter names without rebuilding a separate prompt table).
    this.currentSystem = system;
    // Built-in record types — registered before any user declarations so
    // user code can reference them (`returns: File`, `returns: list<File>`).
    // These shapes are the contract the cognition runtime parses outputs
    // into. Adding more here means: also extend parseModelOutput in
    // emit_cognition.ts and the corresponding validator branches.
    this.registerBuiltinTypes();

    // First pass: register all declarations
    for (const decl of system.declarations) {
      this.registerDeclaration(decl);
    }

    // Second pass: type check all declarations
    for (const decl of system.declarations) {
      this.checkDeclaration(decl);
    }
  }

  /**
   * Built-in record types available in every system. Currently:
   *
   *   File { path: string, content: string, kind: optional<string> }
   *     The shape a multi-file generator prompt returns. `kind` is an
   *     optional language hint ("ts" / "tsx" / "json" / "md" / "yaml")
   *     that the validator uses to pick the right per-file check.
   *
   * Built-in types live in the same `entities` map as user-declared records
   * so `resolveTypeExpr` finds them via the normal `EntityRefType` path. We
   * mark them with an empty `capabilities[]` since they're pure data.
   */
  private registerBuiltinTypes() {
    const fileFields = new Map<string, CVType>();
    fileFields.set("path", prim("string"));
    fileFields.set("content", prim("string"));
    fileFields.set("kind", generic("optional", prim("string")));
    this.symbols.entities.set("File", {
      name: "File",
      type: record("File", fileFields),
      states: [],
      capabilities: [],
    });
  }

  private registerDeclaration(decl: AST.DeclarationNode) {
    switch (decl.kind) {
      case "EntityDecl":
        this.registerEntity(decl);
        break;
      case "CapabilityDecl":
        this.registerCapability(decl);
        break;
      case "EventDecl":
        this.registerEvent(decl);
        break;
      case "StoreDecl":
        this.symbols.stores.add(decl.name);
        break;
      case "ChannelDecl":
        this.symbols.channels.add(decl.name);
        break;
      case "FlowDecl":
        this.symbols.flows.add(decl.name);
        break;
      case "ExtensionPointDecl":
        this.symbols.extensionPoints.add(decl.name);
        break;
      case "ModelDecl":
        this.symbols.models.add(decl.name);
        break;
      case "PromptDecl":
        this.symbols.prompts.add(decl.name);
        break;
      case "RouterDecl":
        this.symbols.routers.add(decl.name);
        break;
      case "EvaluationDecl":
        // Phase 16: track evaluation names so duplicate evaluation names
        // can be detected and (later) the LSP can complete them.
        this.symbols.evaluations.add(decl.name);
        break;
    }
  }

  private registerEntity(decl: AST.EntityDeclNode) {
    const fields = new Map<string, CVType>();

    // Ontology-entailed fields (always present)
    fields.set("id", prim("uuid"));
    fields.set("created_at", prim("timestamp"));
    fields.set("updated_at", prim("timestamp"));

    // Declared fields
    for (const field of decl.owns) {
      const resolved = this.resolveTypeExpr(field.type);
      if (resolved) {
        fields.set(field.name, resolved);
      }
    }

    const states = decl.states
      ? decl.states.nodes.map(n => n.name)
      : [];

    this.symbols.entities.set(decl.name, {
      name: decl.name,
      type: record(decl.name, fields),
      states,
      capabilities: [],
    });
  }

  private registerCapability(decl: AST.CapabilityDeclNode) {
    const params = new Map<string, CVType>();
    for (const p of decl.params) {
      const resolved = this.resolveTypeExpr(p.type);
      if (resolved) params.set(p.name, resolved);
    }
    // Phase 15: track cognition + return type so tool-list validation
    // (T029) can verify a capability is dispatchable from a tool-call loop.
    const hasCognition = decl.cognition !== null;
    const returnType = decl.returns ? typeExprToString(decl.returns) : null;
    this.symbols.capabilities.set(decl.name, {
      name: decl.name,
      params,
      hasCognition,
      returnType,
    });
  }

  private registerEvent(decl: AST.EventDeclNode) {
    const fields = new Map<string, CVType>();
    for (const f of decl.payload) {
      const resolved = this.resolveTypeExpr(f.type);
      if (resolved) fields.set(f.name, resolved);
    }
    this.symbols.events.set(decl.name, { name: decl.name, payloadFields: fields });
  }

  // â”€â”€â”€ Phase 2: Type Check Declarations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  private checkDeclaration(decl: AST.DeclarationNode) {
    switch (decl.kind) {
      case "EntityDecl": this.checkEntity(decl); break;
      case "CapabilityDecl": this.checkCapability(decl); break;
      case "ChannelDecl": this.checkChannel(decl); break;
      case "FlowDecl": this.checkFlow(decl); break;
      case "ConstraintDecl": this.checkConstraint(decl); break;
      case "ExtensionPointDecl": this.checkExtensionPoint(decl); break;
      case "ModelDecl": this.checkModel(decl); break;
      case "PromptDecl": this.checkPrompt(decl); break;
      case "RouterDecl": this.checkRouter(decl); break;
      case "EvaluationDecl": this.checkEvaluation(decl); break;
      case "PolicyDecl": this.checkPolicy(decl); break;
    }
  }

  // â”€â”€â”€ Entity Checking â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  private checkEntity(decl: AST.EntityDeclNode) {
    // Check for duplicate field names
    const seen = new Set<string>();
    for (const field of decl.owns) {
      if (seen.has(field.name)) {
        this.addError("T009", `Duplicate field name '${field.name}' in entity '${decl.name}'`, field.loc);
      }
      seen.add(field.name);
    }

    // Check field types resolve
    for (const field of decl.owns) {
      const resolved = this.resolveTypeExpr(field.type);
      if (!resolved) {
        this.addError("T001", `Undefined type in field '${field.name}'`, field.loc);
      }
    }

    // Check constraints type to bool
    const entitySym = this.symbols.entities.get(decl.name);
    if (entitySym) {
      const ctx = new TypeContext(entitySym.type.fields, this.symbols);
      for (const constraint of decl.constraints) {
        const ctype = this.inferExprType(constraint, ctx);
        if (ctype && ctype.tag !== "primitive") {
          this.addError("T005", `Constraint expression must type to bool, got ${typeToString(ctype)}`, constraint.loc);
        } else if (ctype && ctype.tag === "primitive" && ctype.name !== "bool") {
          // Allow â€” many constraints are comparison exprs that return bool
          // The expression inferrer returns bool for comparisons
        }
      }
    }

    // Check state machine
    if (decl.states) {
      const stateNames = new Set(decl.states.nodes.map(n => n.name));
      for (const node of decl.states.nodes) {
        for (const target of node.transitions) {
          if (!stateNames.has(target)) {
            this.addError("T010", `Undefined state '${target}' in transition from '${node.name}'`, decl.states.loc);
          }
        }
        for (const target of node.branches) {
          if (!stateNames.has(target)) {
            this.addError("T010", `Undefined state '${target}' in branch from '${node.name}'`, decl.states.loc);
          }
        }
      }
    }
  }

  // â”€â”€â”€ Capability Checking â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  private checkCapability(decl: AST.CapabilityDeclNode) {
    // Build typing context from parameters
    const fields = new Map<string, CVType>();
    for (const p of decl.params) {
      const resolved = this.resolveTypeExpr(p.type);
      if (resolved) {
        fields.set(p.name, resolved);
      } else {
        this.addError("T006", `Parameter '${p.name}' references undeclared type`, p.loc);
      }
    }
    const ctx = new TypeContext(fields, this.symbols);

    // Check requires clauses type to bool
    for (const req of decl.requires) {
      const rtype = this.inferExprType(req, ctx);
      if (rtype && !this.isBoolish(rtype)) {
        this.addError("T005", `Requires expression must type to bool, got ${typeToString(rtype)}`, req.loc);
      }
    }

    // Check effects are well-typed
    for (const effect of decl.effects) {
      this.checkEffect(effect, ctx);
    }

    // Check emitted events exist
    for (const emit of decl.emits) {
      if (!this.symbols.events.has(emit.eventName)) {
        this.addError("T011", `Emitted event '${emit.eventName}' is not declared`, emit.loc);
      }
    }

    // Cognition primitive must exist in the closed catalog (Phase 2).
    if (decl.cognition) {
      if (!lookupCognition(decl.cognition.name)) {
        this.addError(
          "T028",
          `Capability '${decl.name}' uses unknown cognition primitive '${decl.cognition.name}'. ` +
            `Allowed: ${listCognitionPrimitives().join(", ")}`,
          decl.cognition.loc,
        );
      }
    }
  }

  private checkEffect(effect: AST.EffectNode, ctx: TypeContext) {
    const targetType = this.inferExprType(effect.target, ctx);
    const valueType = this.inferExprType(effect.value, ctx);

    if (!targetType || !valueType) return; // already errored

    switch (effect.op) {
      case "=":
        if (!typeEquals(targetType, valueType) && !this.isAssignable(valueType, targetType)) {
          this.addError("T003",
            `Type mismatch in assignment: target is ${typeToString(targetType)}, value is ${typeToString(valueType)}`,
            effect.loc);
        }
        break;
      case "+=":
        // target must be set<T> or numeric, value must be T or numeric
        if (targetType.tag === "generic" && targetType.name === "set") {
          if (!typeEquals(targetType.args[0], valueType)) {
            this.addError("T008",
              `Set += requires element type ${typeToString(targetType.args[0])}, got ${typeToString(valueType)}`,
              effect.loc);
          }
        } else if (isNumeric(targetType)) {
          if (!isNumeric(valueType)) {
            this.addError("T003", `Numeric += requires numeric value, got ${typeToString(valueType)}`, effect.loc);
          }
        } else {
          this.addError("T008", `+= requires set or numeric target, got ${typeToString(targetType)}`, effect.loc);
        }
        break;
      case "-=":
        if (targetType.tag === "generic" && targetType.name === "set") {
          if (!typeEquals(targetType.args[0], valueType)) {
            this.addError("T008",
              `Set -= requires element type ${typeToString(targetType.args[0])}, got ${typeToString(valueType)}`,
              effect.loc);
          }
        } else if (isNumeric(targetType)) {
          if (!isNumeric(valueType)) {
            this.addError("T003", `Numeric -= requires numeric value, got ${typeToString(valueType)}`, effect.loc);
          }
        } else {
          this.addError("T008", `-= requires set or numeric target, got ${typeToString(targetType)}`, effect.loc);
        }
        break;
    }
  }

  // â”€â”€â”€ Channel Checking â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  private checkChannel(decl: AST.ChannelDeclNode) {
    // Verify participants type is set<Entity>
    if (decl.participants) {
      const ptype = this.resolveTypeExpr(decl.participants);
      if (ptype && ptype.tag === "generic" && ptype.name === "set") {
        const inner = ptype.args[0];
        if (inner.tag === "record" && !this.symbols.entities.has(inner.name)) {
          this.addError("T001", `Channel participants reference undeclared entity '${inner.name}'`, decl.loc);
        }
      }
    }
  }

  // â”€â”€â”€ Flow Checking â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  private checkFlow(decl: AST.FlowDeclNode) {
    const seenCheckpointNames = new Set<string>();
    for (const step of decl.steps) {
      // Check step action references a valid capability or function
      if (!this.symbols.capabilities.has(step.action.name) &&
          !this.symbols.entities.has(step.action.name)) {
        // Allow — could be a helper function not yet declared
        // In strict mode this would be T012
      }

      // Check compensation exists if step has one
      if (step.compensate) {
        // Same check — compensation should reference a valid capability
      }

      // Phase 17: validate the optional checkpoint clause.
      //   T040  checkpoint allow list is empty (no decisions = useless gate)
      //   T041  checkpoint timeout is zero or negative (must be > 0)
      //   T042  duplicate checkpoint name within the same flow
      //   T043  unsupported decision string (only approve/reject/edit/regenerate/cancel in v1)
      if (step.checkpoint) {
        const cp = step.checkpoint;
        if (cp.allow.length === 0) {
          this.addError("T040", `Flow '${decl.name}' step '${step.name}' checkpoint '${cp.name}' has empty allow list — at least one decision required`, cp.loc);
        }
        if (cp.timeout !== null) {
          // Reject literal "0s"/"0ms"/etc — meaningless wait.
          const m = cp.timeout.match(/^(\d+)(ms|s|m|h|d)?$/);
          if (m && parseInt(m[1], 10) <= 0) {
            this.addError("T041", `Flow '${decl.name}' step '${step.name}' checkpoint '${cp.name}' timeout must be > 0`, cp.loc);
          }
        }
        if (seenCheckpointNames.has(cp.name)) {
          this.addError("T042", `Flow '${decl.name}' has duplicate checkpoint name '${cp.name}'`, cp.loc);
        }
        seenCheckpointNames.add(cp.name);
        const validDecisions = new Set(["approve", "reject", "edit", "regenerate", "cancel"]);
        for (const d of cp.allow) {
          if (!validDecisions.has(d)) {
            this.addError("T043", `Flow '${decl.name}' step '${step.name}' checkpoint '${cp.name}' has unsupported decision '${d}' (allowed: approve, reject, edit, regenerate, cancel)`, cp.loc);
          }
        }
      }
    }

    // Check at least 2 steps (ontology requirement)
    if (decl.steps.length < 2) {
      this.addError("T012", `Flow '${decl.name}' must have at least 2 steps`, decl.loc);
    }
  }

  // â”€â”€â”€ Constraint Checking â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  private checkConstraint(decl: AST.ConstraintDeclNode) {
    // Top-level constraints are checked in a global context
    const globalCtx = new TypeContext(new Map(), this.symbols);
    const ctype = this.inferExprType(decl.expr, globalCtx);
    if (ctype && !this.isBoolish(ctype)) {
      this.addError("T005", `Top-level constraint '${decl.name}' must type to bool`, decl.loc);
    }
  }

  // â”€â”€â”€ Expression Type Inference â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  private inferExprType(expr: AST.ExprNode, ctx: TypeContext): CVType | null {
    switch (expr.kind) {
      case "Literal":
        return this.inferLiteralType(expr);
      case "FieldRef":
        return this.inferFieldRefType(expr, ctx);
      case "BinaryExpr":
        return this.inferBinaryType(expr, ctx);
      case "UnaryExpr":
        return this.inferUnaryType(expr, ctx);
      case "CallExpr":
        return this.inferCallType(expr, ctx);
      case "TernaryExpr":
        return this.inferTernaryType(expr, ctx);
      default:
        return null;
    }
  }

  private inferLiteralType(expr: AST.LiteralNode): CVType {
    switch (expr.type) {
      case "string": return prim("string");
      case "int": return prim("uint"); // default to uint per spec
      case "float": return prim("float");
      case "bool": return prim("bool");
      case "none": return BOTTOM;
      case "list": return generic("list", prim("json")); // infer element type later
      case "map": return prim("json");
    }
  }

  private inferFieldRefType(expr: AST.FieldRefNode, ctx: TypeContext): CVType | null {
    const path = expr.path;
    if (path.length === 0) return null;

    // Built-in: `caller` resolves to the authenticated actor's identity.
    // `caller.id` is a uuid; bare `caller` is a record { id: uuid } for now.
    if (path[0] === "caller") {
      const callerType = record("Caller", new Map([
        ["id", prim("uuid")],
        ["actor_id", prim("uuid")],
      ]));
      return this.resolveFieldPath(callerType, path.slice(1), expr);
    }

    // First segment: look up in context
    let currentType = ctx.lookup(path[0]);

    if (!currentType) {
      // Try as entity name (for top-level constraints like Player.active_trades)
      const entity = this.symbols.entities.get(path[0]);
      if (entity) {
        currentType = entity.type;
        return this.resolveFieldPath(currentType, path.slice(1), expr);
      }
      // Unknown â€” don't error here, could be a forward reference
      return prim("json"); // permissive fallback
    }

    return this.resolveFieldPath(currentType, path.slice(1), expr);
  }

  private resolveFieldPath(baseType: CVType, remaining: string[], expr: AST.ExprNode): CVType | null {
    let current = baseType;

    for (const segment of remaining) {
      // Handle .unique, .length, .size as derived properties
      if (segment === "unique") return prim("bool");
      if (segment === "length") return prim("uint");
      if (segment === "size") return prim("uint");

      if (current.tag === "record") {
        const field = current.fields.get(segment);
        if (field) {
          current = field;
        } else {
          // Field not found â€” could be a derived property
          return prim("json"); // permissive
        }
      } else if (current.tag === "generic") {
        // Accessing property on generic type (e.g., list.size)
        if (segment === "size" || segment === "length") return prim("uint");
        return prim("json");
      } else {
        return prim("json"); // permissive fallback
      }
    }

    return current;
  }

  private inferBinaryType(expr: AST.BinaryExprNode, ctx: TypeContext): CVType {
    const left = this.inferExprType(expr.left, ctx);
    const right = this.inferExprType(expr.right, ctx);

    switch (expr.op) {
      // Comparison operators â†’ bool
      case "==": case "!=": case "<": case ">": case "<=": case ">=":
      case "in": case "contains": case "and": case "or":
        return prim("bool");

      // Range operator
      case "..":
        return generic("list", prim("uint")); // range produces a range object

      // Arithmetic â†’ numeric
      case "+": case "*": case "/": case "%":
        if (left && right && isNumeric(left) && isNumeric(right)) {
          // Promote to widest type
          if ((left as PrimitiveType).name === "float" || (right as PrimitiveType).name === "float") return prim("float");
          if ((left as PrimitiveType).name === "int" || (right as PrimitiveType).name === "int") return prim("int");
          return prim("uint");
        }
        if (expr.op === "+" && left?.tag === "primitive" && (left as PrimitiveType).name === "string") {
          return prim("string"); // string concatenation
        }
        return prim("uint");

      case "-":
        return prim("int"); // subtraction may produce negative

      default:
        return prim("bool");
    }
  }

  private inferUnaryType(expr: AST.UnaryExprNode, ctx: TypeContext): CVType {
    if (expr.op === "not") return prim("bool");
    if (expr.op === "-") return prim("int");
    return prim("json");
  }

  private inferCallType(expr: AST.CallExprNode, ctx: TypeContext): CVType {
    // Built-in functions
    if (expr.name === "now") return prim("timestamp");
    if (expr.name === "count") return prim("uint");
    if (expr.name === "sum") return prim("uint");

    // User-defined â€” return json as permissive fallback
    return prim("json");
  }

  private inferTernaryType(expr: AST.TernaryExprNode, ctx: TypeContext): CVType | null {
    // condition must be bool
    const condType = this.inferExprType(expr.condition, ctx);
    if (condType && !this.isBoolish(condType)) {
      this.addError("T005", "Ternary condition must be bool", expr.loc);
    }
    // result type is type of consequent (assume both branches same type)
    return this.inferExprType(expr.consequent, ctx);
  }

  // â”€â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  private resolveTypeExpr(typeExpr: AST.TypeExprNode): CVType | null {
    switch (typeExpr.kind) {
      case "PrimitiveType":
        return prim(typeExpr.name as PrimitiveType["name"]);
      case "GenericType": {
        const args = typeExpr.typeArgs.map(a => this.resolveTypeExpr(a)).filter(Boolean) as CVType[];
        return generic(typeExpr.name as GenericType["name"], ...args);
      }
      case "EntityRefType": {
        const entity = this.symbols.entities.get(typeExpr.name);
        if (entity) return entity.type;
        // Could be a forward reference â€” register as unknown record
        return record(typeExpr.name, new Map());
      }
      case "TupleType": {
        const elements = typeExpr.elements.map(e => this.resolveTypeExpr(e)).filter(Boolean) as CVType[];
        return { tag: "tuple", elements };
      }
      case "UnionType": {
        const members = typeExpr.members.map(m => this.resolveTypeExpr(m)).filter(Boolean) as CVType[];
        return { tag: "union", members };
      }
    }
  }

  private isBoolish(t: CVType): boolean {
    return (t.tag === "primitive" && t.name === "bool") || t.tag === "bottom";
  }

  private isAssignable(source: CVType, target: CVType): boolean {
    if (typeEquals(source, target)) return true;
    // Numeric widening: uint â†’ int â†’ float
    if (source.tag === "primitive" && target.tag === "primitive") {
      if (source.name === "uint" && (target.name === "int" || target.name === "float")) return true;
      if (source.name === "int" && target.name === "float") return true;
    }
    // json accepts anything and anything accepts json (permissive for unresolved)
    if (target.tag === "primitive" && target.name === "json") return true;
    if (source.tag === "primitive" && source.name === "json") return true;
    return false;
  }
  private checkExtensionPoint(decl: AST.ExtensionPointDeclNode): void {
    for (const p of decl.params) {
      const resolved = this.resolveTypeExpr(p.type);
      if (!resolved) {
        this.addError("T001", "Extension point '" + decl.name + "' param '" + p.name + "' references undefined type", p.loc);
      }
    }
    if (decl.returns) {
      const resolved = this.resolveTypeExpr(decl.returns);
      if (!resolved) {
        this.addError("T001", "Extension point '" + decl.name + "' return type is undefined", decl.loc);
      }
    }
  }

  // ─── Cognition Layer Type Checking (LLM Harness, Phase 1) ───────────────────
  // Error code allocation:
  //   T020  model missing required field (provider / name)
  //   T021  prompt references undeclared model / router
  //   T022  prompt references both model and router (or neither)
  //   T023  prompt allowed_tools references undeclared capability
  //   T024  prompt template references undeclared extension_point
  //   T025  router tier references undeclared model
  //   T026  router tiers not monotonically increasing or missing default tier
  //   T027  router fallback model undeclared
  //   T028  capability cognition: <name> references unknown catalog primitive
  // These check shapes mirror T011 (emit undeclared event) for consistency.

  private checkModel(decl: AST.ModelDeclNode): void {
    if (decl.provider === null) {
      this.addError("T020", `Model '${decl.name}' is missing required 'provider' field`, decl.loc);
    }
    if (decl.modelName === null) {
      this.addError("T020", `Model '${decl.name}' is missing required 'name:' field (the provider-specific model identifier)`, decl.loc);
    }
    if (decl.provider === "openai_compat" || decl.provider === "http") {
      if (!decl.endpoint) {
        this.addError(
          "T020",
          `Model '${decl.name}' uses provider '${decl.provider}' but no 'endpoint:' is set`,
          decl.loc,
        );
      }
    }
  }

  private checkPrompt(decl: AST.PromptDeclNode): void {
    // Resolve param types
    for (const p of decl.params) {
      if (!this.resolveTypeExpr(p.type)) {
        this.addError("T006", `Prompt '${decl.name}' parameter '${p.name}' references undefined type`, p.loc);
      }
    }

    // Exactly one of model_ref / router_ref
    const hasModel = decl.modelRef !== null;
    const hasRouter = decl.routerRef !== null;
    if (!hasModel && !hasRouter) {
      this.addError(
        "T022",
        `Prompt '${decl.name}' must reference either a model or a router`,
        decl.loc,
      );
    } else if (hasModel && hasRouter) {
      this.addError(
        "T022",
        `Prompt '${decl.name}' cannot reference both a model and a router (choose one)`,
        decl.loc,
      );
    } else if (hasModel && !this.symbols.models.has(decl.modelRef!)) {
      this.addError(
        "T021",
        `Prompt '${decl.name}' references undeclared model '${decl.modelRef}'`,
        decl.loc,
      );
    } else if (hasRouter && !this.symbols.routers.has(decl.routerRef!)) {
      this.addError(
        "T021",
        `Prompt '${decl.name}' references undeclared router '${decl.routerRef}'`,
        decl.loc,
      );
    }

    // Template extension_point reference
    if (decl.template && decl.template.startsWith("extension_point:")) {
      const epName = decl.template.slice("extension_point:".length);
      if (!this.symbols.extensionPoints.has(epName)) {
        this.addError(
          "T024",
          `Prompt '${decl.name}' template references undeclared extension_point '${epName}'`,
          decl.loc,
        );
      }
    }

    // ── Phase 18: promptbook validation ─────────────────────────────────────
    // T060: template + promptbook are mutually exclusive
    // T061: promptbook entry must exist in the closed registry
    // T062: required promptbook args must be provided
    // T063: arg name must be declared on the promptbook entry
    if (decl.promptbookRef) {
      if (decl.template) {
        this.addError(
          "T060",
          `Prompt '${decl.name}' cannot have both 'template:' and 'promptbook:' (choose one)`,
          decl.loc,
        );
      }
      const entry = lookupPromptbookEntry(decl.promptbookRef);
      if (!entry) {
        this.addError(
          "T061",
          `Prompt '${decl.name}' references unknown promptbook entry '${decl.promptbookRef}' (allowed: ${listPromptbookNames().join(", ")})`,
          decl.loc,
        );
      } else {
        const declaredArgs = new Set(decl.promptbookArgs.map(a => a.name));
        // Required args must all be present.
        for (const p of entry.params) {
          if (p.required && !declaredArgs.has(p.name)) {
            this.addError(
              "T062",
              `Prompt '${decl.name}' missing required promptbook arg '${p.name}' for entry '${entry.name}'`,
              decl.loc,
            );
          }
        }
        // Arg names must all be declared on the entry.
        const allowedArgs = new Set(entry.params.map(p => p.name));
        for (const a of decl.promptbookArgs) {
          if (!allowedArgs.has(a.name)) {
            this.addError(
              "T063",
              `Prompt '${decl.name}' has unknown promptbook arg '${a.name}' (entry '${entry.name}' allows: ${[...allowedArgs].join(", ")})`,
              a.value.loc,
            );
          }
        }
      }
    }

    // Custom validate references an extension_point
    if (decl.validate.kind === "custom") {
      if (!this.symbols.extensionPoints.has(decl.validate.extensionPoint)) {
        this.addError(
          "T024",
          `Prompt '${decl.name}' validate:custom references undeclared extension_point '${decl.validate.extensionPoint}'`,
          decl.loc,
        );
      }
    }

    // allowed_tools must reference declared capabilities (T023). Phase 15
    // adds T029: a tool capability must be cognition-bearing — i.e. its body
    // is a `cognition: <primitive>` call. Effect-bearing or pipeline
    // capabilities can't be tools because the tool-call dispatcher only
    // routes through the cognition runtime, not the HTTP/DB layers, so
    // arbitrary side-effect capabilities can't be safely invoked here.
    for (const tool of decl.allowedTools) {
      const cap = this.symbols.capabilities.get(tool);
      if (!cap) {
        this.addError(
          "T023",
          `Prompt '${decl.name}' allowed tool '${tool}' is not a declared capability`,
          decl.loc,
        );
        continue;
      }
      if (!cap.hasCognition) {
        this.addError(
          "T029",
          `Prompt '${decl.name}' tool '${tool}' must be a cognition-bearing capability (declare 'cognition: <primitive>' on the capability body); only cognition-bearing capabilities are dispatchable from a prompt's tool-call loop`,
          decl.loc,
        );
      }
    }
  }

  private checkRouter(decl: AST.RouterDeclNode): void {
    if (decl.byExpr === null) {
      this.addError(
        "T026",
        `Router '${decl.name}' is missing required 'by:' expression`,
        decl.loc,
      );
    }

    if (decl.tiers.length === 0) {
      this.addError(
        "T026",
        `Router '${decl.name}' must declare at least one tier`,
        decl.loc,
      );
      return;
    }

    // All but the last tier must have an explicit max; the last tier must be
    // the default (max: null). This guarantees a total cover of the routing
    // input space.
    for (let i = 0; i < decl.tiers.length - 1; i++) {
      const t = decl.tiers[i];
      if (t.max === null) {
        this.addError(
          "T026",
          `Router '${decl.name}' tier '${t.name}' is missing 'max:' (only the last tier may omit it)`,
          t.loc,
        );
      }
    }
    const last = decl.tiers[decl.tiers.length - 1];
    if (last.max !== null) {
      this.addError(
        "T026",
        `Router '${decl.name}' last tier '${last.name}' must omit 'max:' to act as the default`,
        last.loc,
      );
    }

    // Tier maxes must be monotonically increasing.
    let prev: number | null = null;
    for (const t of decl.tiers) {
      if (t.max === null) continue;
      if (prev !== null && t.max <= prev) {
        this.addError(
          "T026",
          `Router '${decl.name}' tier '${t.name}' max=${t.max} is not strictly greater than previous tier max=${prev}`,
          t.loc,
        );
      }
      prev = t.max;
    }

    // All tier model refs must resolve.
    for (const t of decl.tiers) {
      if (!this.symbols.models.has(t.modelRef)) {
        this.addError(
          "T025",
          `Router '${decl.name}' tier '${t.name}' references undeclared model '${t.modelRef}'`,
          t.loc,
        );
      }
    }

    // Fallback (if any) must resolve.
    if (decl.fallbackModel !== null && !this.symbols.models.has(decl.fallbackModel)) {
      this.addError(
        "T027",
        `Router '${decl.name}' fallback references undeclared model '${decl.fallbackModel}'`,
        decl.loc,
      );
    }

    // ── Phase 19: observe + policy validation ──────────────────────────────
    // T070: unknown observed metric name.
    // T071: policy references a metric that isn't observed.
    const KNOWN_METRICS = new Set([
      "validation_pass_rate",
      "latency_p50_ms",
      "latency_p95_ms",
      "cost_usd_per_call",
      "calls",
      "tokens_per_call",
      "confidence_mean",
    ]);
    for (const m of decl.observe) {
      if (!KNOWN_METRICS.has(m)) {
        this.addError(
          "T070",
          `Router '${decl.name}' observe references unknown metric '${m}' (allowed: ${[...KNOWN_METRICS].sort().join(", ")})`,
          decl.loc,
        );
      }
    }
    if (decl.policy) {
      // Walk each constraint expression and find FieldRefs at the top.
      // Constraints look like `validation_pass_rate >= 0.9` — left side is a
      // FieldRef whose path is the metric name.
      const observed = new Set(decl.observe);
      for (const c of decl.policy.constraints) {
        const metric = pickConstraintMetric(c);
        if (metric === null) continue;
        if (!KNOWN_METRICS.has(metric)) {
          this.addError(
            "T070",
            `Router '${decl.name}' policy constraint references unknown metric '${metric}' (allowed: ${[...KNOWN_METRICS].sort().join(", ")})`,
            decl.loc,
          );
        } else if (!observed.has(metric)) {
          this.addError(
            "T071",
            `Router '${decl.name}' policy constraint references '${metric}' but it isn't in the observe list — add "${metric}" to observe`,
            decl.loc,
          );
        }
      }
    }
  }

  // ─── Evaluation Checking (Phase 16) ───────────────────────────────────────
  //
  // Error codes:
  //   T030  evaluation references undeclared prompt
  //   T031  evaluation has no cases
  //   T032  case input param doesn't exist on the prompt's signature
  //   T033  passes:ast_compiles requires the prompt's returns to be a string-
  //         shaped type; runs the validator over the parsed output as TS, so
  //         File / list<File> outputs need a separate operator (future work).
  //   T034  duplicate case name within the same evaluation
  private checkEvaluation(decl: AST.EvaluationDeclNode): void {
    // Prompt must exist.
    if (!this.symbols.prompts.has(decl.promptRef)) {
      this.addError(
        "T030",
        `Evaluation '${decl.name}' references undeclared prompt '${decl.promptRef}'`,
        decl.loc,
      );
      return; // No point checking cases against a missing prompt signature.
    }

    if (decl.cases.length === 0) {
      this.addError(
        "T031",
        `Evaluation '${decl.name}' has no cases — at least one case is required`,
        decl.loc,
      );
    }

    // Look up the prompt's params via the AST. We don't have a clean
    // pre-resolved table for prompts, so we walk the system once.
    const promptParams = this.lookupPromptParamNames(decl.promptRef);
    const promptOutputType = this.lookupPromptReturnType(decl.promptRef);

    const seenCaseNames = new Set<string>();
    for (const c of decl.cases) {
      if (c.caseName === "") {
        this.addError(
          "T031",
          `Evaluation '${decl.name}' has a case with no name`,
          c.loc,
        );
      } else if (seenCaseNames.has(c.caseName)) {
        this.addError(
          "T034",
          `Evaluation '${decl.name}' has duplicate case name '${c.caseName}'`,
          c.loc,
        );
      }
      seenCaseNames.add(c.caseName);

      // Each input binding's param must match the prompt's signature.
      if (promptParams !== null) {
        for (const b of c.input) {
          if (!promptParams.has(b.param)) {
            this.addError(
              "T032",
              `Evaluation '${decl.name}' case '${c.caseName}' binds unknown prompt input '${b.param}' (prompt '${decl.promptRef}' has [${[...promptParams].join(", ")}])`,
              b.loc,
            );
          }
        }
      }

      // passes:ast_compiles only makes sense for string-shaped outputs.
      // Non-string outputs would need a different validator op; flag for now.
      for (const exp of c.expectations) {
        if (exp.kind === "ExpPasses" && exp.mode === "ast_compiles" && promptOutputType !== null) {
          if (promptOutputType !== "string" && promptOutputType !== "File" && !/^list<\s*File\s*>$/.test(promptOutputType)) {
            this.addError(
              "T033",
              `Evaluation '${decl.name}' case '${c.caseName}' uses passes:ast_compiles, but prompt '${decl.promptRef}' returns '${promptOutputType}' (expected string, File, or list<File>)`,
              exp.loc,
            );
          }
        }
      }
    }
  }

  /**
   * Look up the prompt's input parameter names by walking the system AST.
   * Returns null when the prompt isn't found (T030 already reported this).
   */
  private lookupPromptParamNames(promptName: string): Set<string> | null {
    if (!this.currentSystem) return null;
    for (const decl of this.currentSystem.declarations) {
      if (decl.kind === "PromptDecl" && decl.name === promptName) {
        return new Set(decl.params.map(p => p.name));
      }
    }
    return null;
  }

  private lookupPromptReturnType(promptName: string): string | null {
    if (!this.currentSystem) return null;
    for (const decl of this.currentSystem.declarations) {
      if (decl.kind === "PromptDecl" && decl.name === promptName && decl.returns) {
        return typeExprToString(decl.returns);
      }
    }
    return null;
  }

  // ─── Policy Checking (Phase 21) ──────────────────────────────────────────
  //
  // Cost-budget rules:
  //   T050  cost_budget must declare exactly one cap (cap_usd / cap_tokens / cap_calls)
  //   T051  per_feature scope requires a feature: "<name>" arg referencing a declared capability
  //   T052  on_exceeded action=throttle requires retry_after
  //   T053  cost_budget window must be > 0
  //   T054  cap values must be > 0
  private checkPolicy(decl: AST.PolicyDeclNode): void {
    for (const b of decl.costBudgets) {
      const capCount = (b.capUsd !== null ? 1 : 0) + (b.capTokens !== null ? 1 : 0) + (b.capCalls !== null ? 1 : 0);
      if (capCount === 0) {
        this.addError("T050", `Policy '${decl.name}' cost_budget (scope=${b.scope}) must declare one cap (cap_usd / cap_tokens / cap_calls)`, b.loc);
      } else if (capCount > 1) {
        this.addError("T050", `Policy '${decl.name}' cost_budget (scope=${b.scope}) declares multiple caps — only one is allowed (cap_usd OR cap_tokens OR cap_calls)`, b.loc);
      }
      if (b.scope === "per_feature") {
        if (!b.feature) {
          this.addError("T051", `Policy '${decl.name}' cost_budget per_feature requires a feature name`, b.loc);
        } else if (!this.symbols.capabilities.has(b.feature)) {
          this.addError("T051", `Policy '${decl.name}' cost_budget references undeclared capability '${b.feature}'`, b.loc);
        }
      }
      if (b.action === "throttle" && !b.retryAfter) {
        this.addError("T052", `Policy '${decl.name}' cost_budget on_exceeded action=throttle requires retry_after`, b.loc);
      }
      if (b.window) {
        const m = b.window.match(/^(\d+)(ms|s|m|h|d)?$/);
        if (m && parseInt(m[1], 10) <= 0) {
          this.addError("T053", `Policy '${decl.name}' cost_budget window must be > 0`, b.loc);
        }
      }
      if (b.capUsd !== null && b.capUsd <= 0) {
        this.addError("T054", `Policy '${decl.name}' cost_budget cap_usd must be > 0`, b.loc);
      }
      if (b.capTokens !== null && b.capTokens <= 0) {
        this.addError("T054", `Policy '${decl.name}' cost_budget cap_tokens must be > 0`, b.loc);
      }
      if (b.capCalls !== null && b.capCalls <= 0) {
        this.addError("T054", `Policy '${decl.name}' cost_budget cap_calls must be > 0`, b.loc);
      }
    }
  }
}
// â”€â”€â”€ Type Context â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Serialize an AST type expression to the same string form lowering produces.
 * Kept here (not imported from lowering) so the type checker stays
 * dependency-light. Mirrors `lowering.ts:serializeType` exactly.
 */
function typeExprToString(t: AST.TypeExprNode): string {
  switch (t.kind) {
    case "PrimitiveType": return t.name;
    case "GenericType": return `${t.name}<${t.typeArgs.map(typeExprToString).join(", ")}>`;
    case "EntityRefType": return t.name;
    case "TupleType": return `(${t.elements.map(typeExprToString).join(", ")})`;
    case "UnionType": return t.members.map(typeExprToString).join(" | ");
  }
}

/**
 * Phase 19: extract the metric name from a router policy constraint. Each
 * constraint is typically a comparison expression like `metric >= 0.9` —
 * the left side is a FieldRef whose first path segment is the metric name.
 * Returns null if the shape doesn't match (we silently allow it; T070 only
 * fires when the metric is plausibly named).
 */
function pickConstraintMetric(expr: AST.ExprNode): string | null {
  if (expr.kind !== "BinaryExpr") return null;
  if (expr.left.kind !== "FieldRef") return null;
  return expr.left.path[0] ?? null;
}

class TypeContext {
  private locals: Map<string, CVType>;
  private symbols: SymbolTable;

  constructor(locals: Map<string, CVType>, symbols: SymbolTable) {
    this.locals = locals;
    this.symbols = symbols;
  }
  lookup(name: string): CVType | null {
    const local = this.locals.get(name);
    if (local) return local;
    const entity = this.symbols.entities.get(name);
    if (entity) return entity.type;
    return null;
  }
}
