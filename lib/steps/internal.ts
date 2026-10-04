// Lets the step tools run the EXISTING tools in-process: the same registered handlers (validation, null handling,
// failure switches, partner-format answers), with every call written to the call log under its real connector.
import type { McpServer } from "@modelcontextprotocol/server";
import { registerCustomTools } from "@/lib/custom/tools";
import { sql } from "@/lib/db";
import { registerDelhiveryTools } from "@/lib/delhivery/tools";
import { registerGnaniTools } from "@/lib/gnani/tools";
import { registerJanusCoreTools, registerPing } from "@/lib/janus-core";
import { registerPineLabsTools } from "@/lib/pinelabs/tools";
import { registerWhatsAppTools } from "@/lib/whatsapp/tools";

type McpResult = { content?: { text?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
type Handler = (args: unknown) => Promise<McpResult>;

const GROUPS: [string, (server: McpServer) => void][] = [
  ["janus_core", (s) => { registerPing(s); registerJanusCoreTools(s); }],
  ["gnani", registerGnaniTools],
  ["delhivery", registerDelhiveryTools],
  ["pinelabs", registerPineLabsTools],
  ["custom", registerCustomTools],
  ["whatsapp", registerWhatsAppTools],
];

const HANDLERS = new Map<string, { group: string; handler: Handler }>();
for (const [group, register] of GROUPS) {
  register({ registerTool: (name: string, _config: unknown, handler: Handler) => HANDLERS.set(name, { group, handler }) } as unknown as McpServer);
}

export type Step = { tool: string; connector: string; ok: boolean; status?: number | null; error_code?: string | null };
export type Call = { ok: boolean; status: number | null; body: Record<string, unknown> & { [k: string]: any }; malformed: boolean; text: string };

// One step tool run: collects the internal calls it made, for its `steps` answer.
export class StepRun {
  steps: Step[] = [];
  constructor(public stepTool: string) {}

  async call(tool: string, args: Record<string, unknown>): Promise<Call> {
    const entry = HANDLERS.get(tool);
    if (!entry) throw new Error(`Unknown internal tool ${tool}`);
    const started = Date.now();
    const result = await entry.handler(args);
    const text = result.content?.[0]?.text ?? "";
    const http = text.match(/^HTTP (\d+): /);
    let body: Call["body"] = (result.structuredContent ?? {}) as Call["body"];
    let malformed = false;
    if (!result.structuredContent) {
      try {
        const parsed = JSON.parse(http ? text.slice(http[0].length) : text);
        body = Array.isArray(parsed) ? ({ items: parsed } as Call["body"]) : parsed;
      } catch {
        malformed = true;
      }
    }
    const status = http ? Number(http[1]) : malformed ? null : 200;
    const ok = !malformed && !result.isError && body.ok !== false;
    const errorCode = (body.error_code as string) ?? (body.code as string) ?? (malformed ? "MALFORMED" : null);
    this.steps.push({ tool, connector: entry.group, ok, status, error_code: ok ? null : errorCode });
    try {
      await sql`
        INSERT INTO ops.tool_calls (connector, method, tool, args, http_status, outcome, error_code, duration_ms, user_agent)
        VALUES (${entry.group}, 'tools/call', ${tool}, ${JSON.stringify(args).slice(0, 2000)}::jsonb, ${status},
                ${ok ? "ok" : result.isError || malformed ? "error" : "failed"}, ${ok ? null : errorCode},
                ${Date.now() - started}, ${"step:" + this.stepTool})`;
    } catch (err) {
      console.error("[steps] could not log internal call", err);
    }
    return { ok, status, body, malformed, text };
  }
}
