import { after } from "next/server";
import { sql } from "./db";

type Handler = (req: Request) => Promise<Response>;
type RpcMessage = { method?: string; params?: { name?: string; arguments?: unknown } };

const MAX_ARGS_CHARS = 2000;

function trimArgs(args: unknown): unknown {
  if (args === undefined) return null;
  const text = JSON.stringify(args);
  return text.length <= MAX_ARGS_CHARS ? args : { truncated: text.slice(0, MAX_ARGS_CHARS) };
}

// Read ok / error_code / isError out of a JSON or SSE ("data: {...}") MCP response.
function outcomeOf(responseText: string): { outcome: string | null; error_code: string | null } {
  const line = responseText.split("\n").find((l) => l.startsWith("data: "));
  try {
    const result = JSON.parse(line ? line.slice(6) : responseText)?.result;
    if (!result || !("content" in result)) return { outcome: null, error_code: null };
    if (result.isError) return { outcome: "error", error_code: null };
    const body = result.structuredContent;
    if (body && body.ok === false) return { outcome: "failed", error_code: body.error_code ?? null };
    return { outcome: "ok", error_code: null };
  } catch {
    return { outcome: null, error_code: null };
  }
}

// Wraps a route so every request is recorded in ops.tool_calls, after the response has been sent.
export function withCallLog(connector: string, handler: Handler): Handler {
  return async (req) => {
    const started = Date.now();
    let messages: RpcMessage[] = [];
    if (req.method === "POST") {
      try {
        const parsed = JSON.parse(await req.clone().text());
        messages = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        // not JSON; the MCP handler will answer with its own error
      }
    }

    const response = await handler(req);
    const copy = response.clone();
    after(async () => {
      try {
        const text = await copy.text();
        const { outcome, error_code } = outcomeOf(text);
        const duration = Date.now() - started;
        const rows = messages.length ? messages : [{ method: req.method }];
        for (const m of rows) {
          const method = response.status === 401 ? "unauthorized" : (m.method ?? req.method);
          await sql`
            INSERT INTO ops.tool_calls (connector, method, tool, args, http_status, outcome, error_code, duration_ms, user_agent)
            VALUES (${connector}, ${method}, ${m.params?.name ?? null},
                    ${m.method === "tools/call" ? JSON.stringify(trimArgs(m.params?.arguments)) : null}::jsonb,
                    ${response.status}, ${m.method === "tools/call" ? outcome : null}, ${error_code},
                    ${duration}, ${req.headers.get("user-agent")})`;
        }
      } catch (err) {
        console.error("[calllog] could not record call", err);
      }
    });
    return response;
  };
}
