// Thin wrapper around Twilio's REST API (real, not a mock) for outgoing WhatsApp messages and calls.
// Docs: https://www.twilio.com/docs/messaging/api/message-resource and https://www.twilio.com/docs/voice/api/call-resource
import { ToolError } from "@/lib/mcp";

const API = "https://api.twilio.com/2010-04-01";
export const TWILIO_TIMEOUT_MS = 8000; // AgenticOrg gives a tool 10 s in total
export const SANDBOX_NUMBER = "whatsapp:+14155238886";

// What to tell Janus for the Twilio error codes it can act on.
const KNOWN_CODES: Record<number, { code: string; message: string }> = {
  21211: { code: "INVALID_PHONE", message: "Twilio says the 'to' number is not a valid phone number." },
  21614: { code: "INVALID_PHONE", message: "Twilio says the 'to' number can't receive this message." },
  20003: { code: "TWILIO_AUTH_FAILED", message: "Twilio rejected our credentials. Tell Track A (check TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN in Vercel)." },
  63015: { code: "NOT_JOINED_SANDBOX", message: "" }, // filled in by sandboxJoinMessage()
  63016: { code: "OUTSIDE_24H_WINDOW", message: "This person hasn't messaged in the last 24 hours, so WhatsApp only allows an approved template. Use Gmail instead." },
  63038: { code: "DAILY_LIMIT_REACHED", message: "The Twilio account has reached its daily WhatsApp message limit. Don't retry today; use Gmail instead and tell Track A." },
};

export function sandboxJoinMessage(): string {
  const join = process.env.TWILIO_SANDBOX_JOIN ?? "join against-neighbor";
  return `This number hasn't joined the Twilio WhatsApp sandbox. Ask them to send '${join}' to +1 415 523 8886 on WhatsApp, then try again.`;
}

// Map a Twilio error (HTTP status + Twilio error code + message) to one of our error codes.
export function mapTwilioError(httpStatus: number | null, twilioCode: number | null, twilioMessage: string | null): ToolError {
  const details = { twilio_code: twilioCode, twilio_message: twilioMessage };
  if (twilioCode !== null && KNOWN_CODES[twilioCode]) {
    const known = KNOWN_CODES[twilioCode];
    return new ToolError(known.code, known.code === "NOT_JOINED_SANDBOX" ? sandboxJoinMessage() : known.message, details);
  }
  if (httpStatus === 401) return new ToolError("TWILIO_AUTH_FAILED", KNOWN_CODES[20003].message, details);
  if (httpStatus === 429) return new ToolError("TWILIO_RATE_LIMITED", "Twilio is rate-limiting us (one retry after 3.5 s was already tried when time allowed). Wait a little before sending again.", details);
  return new ToolError("TWILIO_ERROR", `Twilio error${twilioCode ? ` ${twilioCode}` : ""}: ${twilioMessage ?? "unknown"}`, details);
}

export function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// Spoken call script. The AI disclosure always comes first (hard rule).
export const AI_DISCLOSURE = "Hello, this is Janus, an AI assistant.";
export function buildCallTwiml(message: string, language: "en-IN" | "hi-IN"): string {
  const text = `${AI_DISCLOSURE} ${message}`;
  return `<Response><Say voice="Polly.Aditi" language="${language}">${escapeXml(text)}</Say></Response>`;
}

function credentials(): { sid: string; token: string } {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new ToolError("SERVER_MISCONFIGURED", "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are not set on the server. Tell Track A.");
  return { sid, token };
}

type TwilioJson = Record<string, unknown>;

// One request to Twilio. Never retries (a retry could send a message twice).
export async function twilioRequest(path: string, form?: Record<string, string>, timeoutMs = TWILIO_TIMEOUT_MS): Promise<TwilioJson> {
  const { sid, token } = credentials();
  let res: Response;
  try {
    res = await fetch(`${API}/Accounts/${sid}/${path}`, {
      method: form ? "POST" : "GET",
      headers: {
        authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
        ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if ((err as Error).name === "TimeoutError") {
      throw new ToolError("TWILIO_TIMEOUT", `Twilio did not answer within ${(timeoutMs / 1000).toFixed(1)} seconds. The message may still have been sent: check get_message_status before resending.`, { twilio_code: null });
    }
    throw new ToolError("TWILIO_ERROR", `Could not reach Twilio: ${(err as Error).message}`, { twilio_code: null });
  }
  const json = (await res.json().catch(() => ({}))) as TwilioJson;
  if (!res.ok) throw mapTwilioError(res.status, (json.code as number) ?? null, (json.message as string) ?? null);
  return json;
}
