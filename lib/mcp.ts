import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

// Throw this inside a tool to return { ok:false, error_code, message } to Janus.
export class ToolError extends Error {
  constructor(
    public code: string,
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

type Body = Record<string, unknown>;

// Postgres error codes we can explain in plain English.
function explainDbError(err: { code?: string; detail?: string; message?: string }): ToolError | null {
  const detail = err.detail ?? err.message ?? "";
  switch (err.code) {
    case "23503":
      return new ToolError("INVALID_REFERENCE", `An id you passed does not exist. ${detail}`.trim());
    case "23505":
      return new ToolError("DUPLICATE", `That record already exists. ${detail}`.trim());
    case "23514":
    case "22P02":
    case "22007":
    case "22008":
      return new ToolError("INVALID_VALUE", `A value is not allowed: ${detail}`.trim());
    default:
      return null;
  }
}

// The SDK would reject bad input itself, with a plain-text error. Instead we give it the zod schema's
// JSON Schema (so the tool list still shows every field rule) with a validate() that lets everything
// through, and run zod ourselves so bad input also comes back as { ok:false, error_code:"INVALID_INPUT" }.
function listedOnly(schema: z.ZodObject) {
  return {
    "~standard": {
      version: 1 as const,
      vendor: "janus",
      jsonSchema: schema["~standard"].jsonSchema,
      validate: (value: unknown) => ({ value }),
    },
  };
}

// AgenticOrg sends `null` for optional fields the agent didn't fill (e.g. media_url: null). Treat such a null
// as "not given": drop the key before validating. Fields that deliberately accept null keep it (e.g.
// job_update technician_id: null = unassign), and required fields stay required. Works inside nested objects
// (e.g. plan_details) and arrays of objects (e.g. payments[]).
type AnySchema = z.ZodType & { _zod: { def: { innerType?: AnySchema; element?: AnySchema } } };

function unwrapTo<T>(schema: AnySchema, kind: new (...args: never[]) => T): T | null {
  let current: AnySchema | undefined = schema;
  for (let i = 0; i < 6 && current; i++) {
    if (current instanceof kind) return current as T;
    current = current._zod.def.innerType;
  }
  return null;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export function dropNullOptionals(schema: z.ZodObject, value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = { ...value };
  for (const [key, v] of Object.entries(value)) {
    const field = schema.shape[key] as AnySchema | undefined;
    if (!field) continue;
    if (v === null) {
      if (!field.safeParse(null).success && field.safeParse(undefined).success) delete out[key];
      continue;
    }
    const nested = unwrapTo(field, z.ZodObject);
    if (nested && isPlainObject(v)) {
      out[key] = dropNullOptionals(nested, v);
      continue;
    }
    const array = unwrapTo(field, z.ZodArray);
    const element = array ? unwrapTo((array as unknown as AnySchema)._zod.def.element as AnySchema, z.ZodObject) : null;
    if (element && Array.isArray(v)) out[key] = v.map((item) => dropNullOptionals(element, item));
  }
  return out;
}

// The *_update tools take { <id>, fields: {...} }. Agents often send the changes flat instead
// ({ job_id, state }), so move any top-level key that belongs in `fields` into it.
export function liftFlatFields(schema: z.ZodObject, value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const fieldsSchema = schema.shape.fields ? unwrapTo(schema.shape.fields as AnySchema, z.ZodObject) : null;
  if (!fieldsSchema) return value;
  const out: Record<string, unknown> = { ...value };
  const fields: Record<string, unknown> = isPlainObject(out.fields) ? { ...out.fields } : {};
  let moved = false;
  for (const key of Object.keys(value)) {
    if (key in schema.shape || !(key in fieldsSchema.shape)) continue;
    if (!(key in fields)) fields[key] = value[key];
    delete out[key];
    moved = true;
  }
  if (moved || isPlainObject(out.fields)) out.fields = fields;
  return out;
}

function describeIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
}

// ───────────────────────── Mock tools (Delhivery, Pine Labs, custom) ─────────────────────────
// Mocks must answer with the partner's documented response body, unchanged. A handler returns
// { status, body } (or { malformed } for a deliberately broken reply). Errors (status >= 400) are
// marked isError and their text starts with "HTTP <status>:" so Janus can tell a 504 from a 400.
export type MockReply =
  | { status: number; body: unknown }
  | { malformed: string };

export function addMockTool<S extends z.ZodObject>(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: S,
  handler: (args: z.infer<S>) => Promise<MockReply>,
  onInvalid: (issues: z.core.$ZodIssue[]) => MockReply,
) {
  const callback = async (rawArgs: unknown) => {
    let reply: MockReply;
    try {
      const parsed = inputSchema.safeParse(dropNullOptionals(inputSchema, liftFlatFields(inputSchema, rawArgs ?? {})));
      reply = parsed.success ? await handler(parsed.data) : onInvalid(parsed.error.issues);
    } catch (err) {
      console.error(`[mock ${name}]`, err);
      reply = { status: 500, body: { error: "Internal Server Error" } };
    }
    if ("malformed" in reply) return { content: [{ type: "text" as const, text: reply.malformed }] };
    const json = JSON.stringify(reply.body);
    const isError = reply.status >= 400;
    const isObject = reply.body !== null && typeof reply.body === "object" && !Array.isArray(reply.body);
    return {
      content: [{ type: "text" as const, text: isError ? `HTTP ${reply.status}: ${json}` : json }],
      ...(isObject ? { structuredContent: reply.body as Record<string, unknown> } : {}),
      ...(isError ? { isError: true } : {}),
    };
  };
  server.registerTool(name, { description, inputSchema: listedOnly(inputSchema) as never }, callback as never);
}

// Registers a tool whose handler returns a plain object. The result is always JSON with ok:true|false.
export function addTool<S extends z.ZodObject>(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: S,
  handler: (args: z.infer<S>) => Promise<Body>,
) {
  const callback = async (rawArgs: unknown) => {
    let body: Body;
    try {
      const parsed = inputSchema.safeParse(dropNullOptionals(inputSchema, liftFlatFields(inputSchema, rawArgs ?? {})));
      if (!parsed.success) throw new ToolError("INVALID_INPUT", `Invalid input for ${name}: ${describeIssues(parsed.error)}`);
      body = { ok: true, ...(await handler(parsed.data)) };
    } catch (err) {
      const known = err instanceof ToolError ? err : explainDbError(err as never);
      if (known) {
        body = { ok: false, error_code: known.code, message: known.message, ...known.details };
      } else {
        console.error(`[tool ${name}]`, err);
        body = { ok: false, error_code: "INTERNAL_ERROR", message: `Unexpected server error: ${(err as Error).message}` };
      }
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify(body) }],
      structuredContent: body,
    };
  };
  // The SDK's generic types don't follow our wrapper, so it is cast here (input is validated by zod above).
  server.registerTool(name, { description, inputSchema: listedOnly(inputSchema) as never }, callback as never);
}
