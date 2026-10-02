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

function describeIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
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
      const parsed = inputSchema.safeParse(rawArgs ?? {});
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
