// whatsapp_janus MCP tools: Janus sends real WhatsApp messages (and the occasional disclosed call)
// through Twilio. Real API, so answers use our { ok, … } format, like the Gnani connector.
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { sql } from "@/lib/db";
import { addTool, ToolError } from "@/lib/mcp";
import { phoneOrFail, zPhone } from "@/lib/phone";
import { sleep, takeScenario, TIMEOUT_DELAY_MS } from "@/lib/scenarios";
import { isTestNumber, reserveSlot, SEND_COST_MS, sendDeadline, waitForSlot } from "./pace";
import { buildCallTwiml, mapTwilioError, SANDBOX_NUMBER, sandboxJoinMessage, TWILIO_TIMEOUT_MS, twilioRequest } from "./twilio";

const MAX_BODY = 1600;
const MAX_CALL_TEXT = 500;
const FAILED = ["failed", "undelivered"];

// Safety guard: only message people Janus already knows, never a stranger's real number.
async function knownRecipient(rawPhone: string) {
  const phone = phoneOrFail(rawPhone);
  const [member] = await sql`SELECT id, name, household_id FROM members WHERE phone = ${phone}`;
  if (member) return { phone, name: member.name as string, type: "member", member_id: member.id as string, household_id: member.household_id as string };
  const [tech] = await sql`SELECT name FROM technicians WHERE phone = ${phone}`;
  if (tech) return { phone, name: tech.name as string, type: "technician", member_id: null, household_id: null };
  throw new ToolError("RECIPIENT_UNKNOWN", `${phone} is not a known household member or technician. Add them first (member_add or technician_add).`);
}

export function registerWhatsAppTools(server: McpServer) {
  addTool(
    server,
    "send_whatsapp",
    `Send one real WhatsApp message from the Twilio sandbox number to a known household member or technician (anyone else is refused: RECIPIENT_UNKNOWN). Give body (max ${MAX_BODY} characters) and/or media_url (public https link, e.g. a gnani_text_to_speech audio_url for a voice reply). Returns message_sid and Twilio's status (usually queued). If WhatsApp rejects it within a few seconds (not joined the sandbox, outside the 24-hour window) you get that error instead. Never resend after TWILIO_TIMEOUT without checking get_message_status first. Messages to household members are logged as notifications automatically (no need to call notification_log). Sends are paced one at a time, at least 3.5 s apart (sandbox limit), so this call may wait a few seconds; on Twilio 429 it retries once, on 63038 (DAILY_LIMIT_REACHED) it does not. Errors include twilio_code.`,
    z.object({
      to: zPhone,
      body: z.string().max(MAX_BODY).optional(),
      media_url: z.url({ protocol: /^https$/ }).optional().describe("Public https URL of the media to attach"),
    }),
    async ({ to, body, media_url }) => {
      if (!body?.trim() && !media_url) throw new ToolError("INVALID_INPUT", "Give body or media_url (or both).");
      const recipient = await knownRecipient(to);

      // Failure switches for evals: answer without calling Twilio.
      const scenario = await takeScenario("whatsapp.next_send");
      if (scenario === "timeout") {
        await sleep(TIMEOUT_DELAY_MS);
        throw new ToolError("TWILIO_TIMEOUT", "Twilio did not answer in time (simulated by scenario switch). Check get_message_status before resending.", { twilio_code: null, simulated: true });
      }
      if (scenario === "not_joined") throw new ToolError("NOT_JOINED_SANDBOX", sandboxJoinMessage(), { twilio_code: 63015, simulated: true });
      if (scenario === "outside_window") throw mapTwilioErrorSimulated(63016);
      if (scenario === "failed") throw new ToolError("TWILIO_ERROR", "Twilio error 30008: Unknown error (simulated by scenario switch).", { twilio_code: 30008, simulated: true });

      const form: Record<string, string> = {
        To: `whatsapp:${recipient.phone}`,
        From: process.env.TWILIO_WHATSAPP_FROM ?? SANDBOX_NUMBER,
        ...(body?.trim() ? { Body: body } : {}),
        ...(media_url ? { MediaUrl: media_url } : {}),
      };
      // Whole tool under 10 s: a step tool passes its own deadline, otherwise 9 s from now.
      const deadline = sendDeadline.getStore() ?? Date.now() + 9000;
      const attempt = async () => {
        await sleep(reserveSlot()); // at least 3.5 s after the previous send (sandbox: 1 message per 3 s)
        if (scenario === "rate_limited") throw mapTwilioError(429, 20429, "Too Many Requests (simulated by scenario switch)");
        if (scenario === "daily_limit") throw mapTwilioError(429, 63038, "Account exceeded the daily messages limit (simulated by scenario switch)");
        if (isTestNumber(recipient.phone)) throw new ToolError("TEST_NUMBER", "Test number: paced like a real message but not sent to Twilio.", { twilio_code: null, simulated: true });
        return twilioRequest("Messages.json", form, Math.min(TWILIO_TIMEOUT_MS, Math.max(1500, deadline - Date.now())));
      };
      let msg: Record<string, unknown>;
      try {
        msg = await attempt();
      } catch (err) {
        // Twilio 429 = nothing was sent, so one retry (3.5 s later) can't double-send. 63038 (daily limit) is never retried.
        const retryable = err instanceof ToolError && err.code === "TWILIO_RATE_LIMITED";
        if (!retryable) throw err;
        if (Date.now() + waitForSlot() + SEND_COST_MS > deadline) {
          err.details = { ...err.details, retried: false };
          throw err;
        }
        try {
          msg = await attempt();
        } catch (again) {
          if (again instanceof ToolError) again.details = { ...again.details, retried: true };
          throw again;
        }
      }
      let status = msg.status as string;

      // WhatsApp often rejects within a second (63015 / 63016). Look once so Janus isn't told "queued" for a
      // message that has already failed (skipped if it would break the time limit). This only reads the status;
      // it never resends. Later failures: get_message_status.
      for (let i = 0; i < 1 && !FAILED.includes(status) && status !== "delivered" && Date.now() + SEND_COST_MS <= deadline; i++) {
        await sleep(1000);
        const check = await twilioRequest(`Messages/${msg.sid}.json`, undefined, Math.max(500, deadline - Date.now())).catch(() => null);
        if (!check) break;
        status = check.status as string;
        if (FAILED.includes(status)) {
          const err = mapTwilioError(null, (check.error_code as number) ?? null, (check.error_message as string) ?? null);
          err.details = { ...err.details, message_sid: msg.sid, status };
          throw err;
        }
      }

      // Log messages to household members as notifications, so notification_list stays complete without Janus
      // calling notification_log (saves a tool call per turn). A logging failure never turns a sent message into an error.
      let notificationId: string | null = null;
      if (recipient.household_id) {
        try {
          const [n] = await sql`
            INSERT INTO notifications (household_id, member_id, kind, body)
            VALUES (${recipient.household_id}, ${recipient.member_id}, 'whatsapp', ${body?.trim() ? body : `[media] ${media_url}`})
            RETURNING id`;
          notificationId = n.id as string;
        } catch (err) {
          console.error("[send_whatsapp] could not log notification", err);
        }
      }
      return {
        message_sid: msg.sid,
        status,
        to: recipient.phone,
        recipient: { name: recipient.name, type: recipient.type, household_id: recipient.household_id },
        notification_id: notificationId,
        sent_at: new Date().toISOString(),
        partner: "Twilio (real)",
      };
    },
  );

  addTool(
    server,
    "make_call",
    `Place one real voice call to a known household member or technician (anyone else is refused). Use only when allowed by the prompt rules (e.g. a technician who hasn't opted in to WhatsApp). The call always starts with "Hello, this is Janus, an AI assistant." and then reads your message (max ${MAX_CALL_TEXT} characters) in en-IN (default) or hi-IN. Returns call_sid and status.`,
    z.object({
      to: zPhone,
      message: z.string().min(1).max(MAX_CALL_TEXT),
      language: z.enum(["en-IN", "hi-IN"]).default("en-IN"),
    }),
    async ({ to, message, language }) => {
      const recipient = await knownRecipient(to);
      const from = process.env.TWILIO_VOICE_FROM;
      if (!from) {
        throw new ToolError("NO_VOICE_NUMBER", "The Twilio account has no voice-capable number configured (TWILIO_VOICE_FROM), so calls can't be made. Send a WhatsApp message instead.");
      }
      const call = await twilioRequest("Calls.json", { To: recipient.phone, From: from, Twiml: buildCallTwiml(message, language) });
      return {
        call_sid: call.sid,
        status: call.status,
        to: recipient.phone,
        recipient: { name: recipient.name, type: recipient.type },
        partner: "Twilio (real)",
      };
    },
  );

  addTool(
    server,
    "get_message_status",
    "Has a WhatsApp message been delivered? status: queued, sent, delivered, read, failed or undelivered. When it failed, error_code_twilio says why (63015 = not joined the sandbox, 63016 = outside the 24-hour window) and error_hint explains what to do.",
    z.object({ message_sid: z.string().regex(/^(SM|MM)[0-9a-f]{32}$/, "Must be a Twilio message SID (SM… or MM…)") }),
    async ({ message_sid }) => {
      let msg: Record<string, unknown>;
      try {
        msg = await twilioRequest(`Messages/${message_sid}.json`);
      } catch (err) {
        if (err instanceof ToolError && (err.details.twilio_code === 20404)) {
          throw new ToolError("MESSAGE_NOT_FOUND", `No message with sid ${message_sid}.`);
        }
        throw err;
      }
      const code = (msg.error_code as number) ?? null;
      return {
        message_sid,
        status: msg.status,
        error_code_twilio: code,
        twilio_error_code: code, // same value; both names are used by different versions of the prompt
        ...(code ? { error_hint: mapTwilioError(null, code, (msg.error_message as string) ?? null).message } : {}),
        to: String(msg.to ?? "").replace(/^whatsapp:/, ""),
        date_sent: msg.date_sent ? new Date(msg.date_sent as string).toISOString() : null,
        partner: "Twilio (real)",
      };
    },
  );
}

function mapTwilioErrorSimulated(code: number): ToolError {
  const err = mapTwilioError(null, code, "simulated by scenario switch");
  err.details = { ...err.details, simulated: true };
  return err;
}
