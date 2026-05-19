/**
 * MarrowScript OpenAPI Emitter
 * Generates OpenAPI 3.0.3 YAML and JSON specs from an IRSystem.
 */

import * as IR from "./ir";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toSnakeCase(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
}

function toDashCase(s: string): string {
  return toSnakeCase(s).replace(/_/g, "-");
}

function toPascalCase(s: string): string {
  return s.replace(/(^|_)([a-z])/g, (_: string, _p: string, c: string) => c.toUpperCase());
}

function irTypeToOpenApi(irType: string): Record<string, unknown> {
  if (irType === "string") return { type: "string" };
  if (irType === "uint" || irType === "int") return { type: "integer" };
  if (irType === "float") return { type: "number" };
  if (irType === "bool") return { type: "boolean" };
  if (irType === "timestamp") return { type: "string", format: "date-time" };
  if (irType === "uuid") return { type: "string", format: "uuid" };
  if (irType === "bytes") return { type: "string", format: "byte" };
  if (irType === "json") return { type: "object" };
  const listMatch = irType.match(/^list<(.+)>$/);
  if (listMatch) return { type: "array", items: irTypeToOpenApi(listMatch[1]) };
  const setMatch = irType.match(/^set<(.+)>$/);
  if (setMatch) return { type: "array", items: irTypeToOpenApi(setMatch[1]) };
  const optMatch = irType.match(/^optional<(.+)>$/);
  if (optMatch) return { ...irTypeToOpenApi(optMatch[1]), nullable: true };
  return { type: "string" };
}

function ind(n: number): string {
  return "  ".repeat(n);
}

function yamlValue(v: unknown, depth: number): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return String(v);
  if (typeof v === "number") return String(v);
  if (typeof v === "string") {
    if (
      v.includes(":") ||
      v.includes("#") ||
      v.includes("'") ||
      v.startsWith("{") ||
      v.startsWith("[")
    ) {
      return JSON.stringify(v);
    }
    return v;
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    return (
      "\n" +
      v
        .map((item) => ind(depth) + "- " + yamlValue(item, depth + 1))
        .join("\n")
    );
  }
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    return (
      "\n" +
      entries
        .map(([k, val]) => {
          const valStr = yamlValue(val, depth + 1);
          if (valStr.startsWith("\n")) {
            return ind(depth) + k + ":" + valStr;
          }
          return ind(depth) + k + ": " + valStr;
        })
        .join("\n")
    );
  }
  return String(v);
}

function objToYaml(obj: Record<string, unknown>, depth = 0): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const valStr = yamlValue(v, depth + 1);
    if (valStr.startsWith("\n")) {
      lines.push(ind(depth) + k + ":" + valStr);
    } else {
      lines.push(ind(depth) + k + ": " + valStr);
    }
  }
  return lines.join("\n");
}

// ─── Spec builder ─────────────────────────────────────────────────────────────

function buildSpec(system: IR.IRSystem): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  const schemas: Record<string, unknown> = {};

  for (const mod of system.modules) {
    if (mod.kind !== "api_service" || mod.models.length === 0) continue;

    const model = mod.models[0];
    const tableName = toSnakeCase(model.name);
    const modelName = toPascalCase(model.name);
    const collectionPath = "/" + tableName + "s";
    const itemPath = "/" + tableName + "s/{id}";

    const allMethods: IR.IRMethod[] = mod.interfaces.flatMap((i) => i.methods);
    const crudNames = new Set(["create", "read", "update", "delete", "list"]);
    const capabilityMethods = allMethods.filter(
      (m) => !crudNames.has(m.name.toLowerCase())
    );

    const securityRef = [{ BearerAuth: [] }];

    const listOp: Record<string, unknown> = {
      summary: "List " + modelName,
      operationId: "list" + modelName,
      tags: [modelName],
      parameters: [
        { name: "page", in: "query", schema: { type: "integer", default: 1 } },
        {
          name: "page_size",
          in: "query",
          schema: { type: "integer", default: 50 },
        },
      ],
      responses: {
        "200": {
          description: "List of " + modelName,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  items: {
                    type: "array",
                    items: { $ref: "#/components/schemas/" + modelName },
                  },
                  total: { type: "integer" },
                  page: { type: "integer" },
                  page_size: { type: "integer" },
                },
              },
            },
          },
        },
        "401": { description: "Unauthorized" },
      },
    };

    const createOp: Record<string, unknown> = {
      summary: "Create " + modelName,
      operationId: "create" + modelName,
      tags: [modelName],
      security: securityRef,
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/" + modelName },
          },
        },
      },
      responses: {
        "200": {
          description: "Created",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/" + modelName },
            },
          },
        },
        "401": { description: "Unauthorized" },
        "422": { description: "Precondition failed" },
        "400": { description: "Bad request" },
      },
    };

    paths[collectionPath] = { get: listOp, post: createOp };

    const idParam = [
      {
        name: "id",
        in: "path",
        required: true,
        schema: { type: "string", format: "uuid" },
      },
    ];

    paths[itemPath] = {
      get: {
        summary: "Get " + modelName,
        operationId: "get" + modelName,
        tags: [modelName],
        parameters: idParam,
        security: securityRef,
        responses: {
          "200": {
            description: "Found",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/" + modelName },
              },
            },
          },
          "401": { description: "Unauthorized" },
          "400": { description: "Not found" },
        },
      },
      put: {
        summary: "Update " + modelName,
        operationId: "update" + modelName,
        tags: [modelName],
        parameters: idParam,
        security: securityRef,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/" + modelName },
            },
          },
        },
        responses: {
          "200": {
            description: "Updated",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/" + modelName },
              },
            },
          },
          "401": { description: "Unauthorized" },
          "422": { description: "Precondition failed" },
          "400": { description: "Bad request" },
        },
      },
      delete: {
        summary: "Delete " + modelName,
        operationId: "delete" + modelName,
        tags: [modelName],
        parameters: idParam,
        security: securityRef,
        responses: {
          "200": { description: "Deleted" },
          "401": { description: "Unauthorized" },
          "400": { description: "Not found" },
        },
      },
    };

    for (const method of capabilityMethods) {
      const capPath = collectionPath + "/" + toDashCase(method.name);
      // Build an operation-specific request schema from the method's typed
      // inputs. Entity-typed inputs map to the entity's $ref so the caller
      // can post the full entity body inline (the route handler accepts
      // either an `<entity>_id` reference or the inline body); primitive
      // inputs map to their JSON-schema equivalent. This gives the frontend
      // / OpenAPI codegen tools a precise shape per capability instead of
      // the previous generic entity-shaped requestBody.
      const capRequestProps: Record<string, unknown> = {};
      const capRequestRequired: string[] = [];
      const PRIMITIVE_MAP: Record<string, unknown> = {
        string: { type: "string" },
        int: { type: "integer" },
        uint: { type: "integer", minimum: 0 },
        float: { type: "number" },
        bool: { type: "boolean" },
        timestamp: { type: "string", format: "date-time" },
        uuid: { type: "string", format: "uuid" },
        bytes: { type: "string", format: "byte" },
        json: { type: "object", additionalProperties: true },
      };
      for (const inp of method.input) {
        const isPrimitive = inp.type in PRIMITIVE_MAP;
        if (isPrimitive) {
          capRequestProps[inp.name] = PRIMITIVE_MAP[inp.type];
          capRequestRequired.push(inp.name);
        } else if (inp.type.startsWith("list<") || inp.type.startsWith("set<")) {
          capRequestProps[inp.name] = { type: "array", items: {} };
        } else {
          // Entity-typed input. Frontend may send either `<name>_id` (UUID
          // reference) or the inline entity body. We document both shapes
          // via oneOf so OpenAPI codegen still produces a clean type.
          capRequestProps[inp.name + "_id"] = { type: "string", format: "uuid", description: "UUID of an existing " + inp.type + " row (alternative to inline body)" };
          // Spread the entity's own properties at the top level so the
          // caller can post the body inline without nesting.
          const entityModel = mod.models.find(mm => mm.name === inp.type);
          if (entityModel) {
            for (const f of entityModel.fields) {
              if (!(f.name in capRequestProps)) {
                capRequestProps[f.name] = irTypeToOpenApi(f.type);
              }
            }
          }
        }
      }
      const isPipeline = !!method.pipeline;
      const capRequestSchema: Record<string, unknown> = {
        type: "object",
        properties: capRequestProps,
      };
      if (capRequestRequired.length > 0) capRequestSchema.required = capRequestRequired;

      // Pipeline capabilities surface the typed { ok, action, trace_id,
      // results } shape — the results map is per-pipeline so we leave it
      // open. Plain capabilities still return { ok, action }.
      const successProps: Record<string, unknown> = {
        ok: { type: "boolean" },
        action: { type: "string" },
      };
      if (isPipeline) {
        successProps.trace_id = { type: "string", format: "uuid", nullable: true };
        successProps.results = { type: "object", additionalProperties: true };
      }

      const capOp: Record<string, unknown> = {
        summary: method.name + " on " + modelName,
        operationId: method.name + modelName,
        tags: [modelName],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: capRequestSchema,
            },
          },
        },
        responses: {
          "200": {
            description: "Success",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: successProps,
                },
              },
            },
          },
          "400": { description: "Bad request" },
          "401": { description: "Unauthorized" },
          "404": { description: "Not found" },
          "422": { description: "Precondition failed" },
        },
      };
      if (method.authenticated) {
        capOp.security = securityRef;
      }
      paths[capPath] = { post: capOp };
    }

    const properties: Record<string, unknown> = {};
    for (const field of model.fields) {
      properties[field.name] = irTypeToOpenApi(field.type);
    }
    schemas[modelName] = {
      type: "object",
      properties,
    };
  }

  return {
    openapi: "3.0.3",
    info: {
      title: system.name,
      version: system.version,
      description: "Generated by MarrowScript compiler",
    },
    servers: [{ url: "http://localhost:3000" }],
    paths,
    components: {
      securitySchemes: {
        BearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
      schemas,
    },
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function emitOpenApiSpec(system: IR.IRSystem): string {
  const spec = buildSpec(system);
  const lines: string[] = ["# Generated by MarrowScript compiler"];
  lines.push(objToYaml(spec));
  return lines.join("\n") + "\n";
}

export function emitOpenApiJson(system: IR.IRSystem): string {
  return JSON.stringify(buildSpec(system), null, 2);
}
