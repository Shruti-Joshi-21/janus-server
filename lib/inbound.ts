import nodemailer from "nodemailer";

// The JSON Janus receives for every incoming WhatsApp message (agreed with Track B).
export type InboundEvent = {
  channel: "whatsapp";
  from_phone: string;
  text: string | null;
  media_url: string | null;
  media_type: string | null;
  latitude: number | null;
  longitude: number | null;
  received_at: string;
  twilio_message_sid: string | null;
};

function numberOrNull(v: string | undefined): number | null {
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Twilio form fields → event. 'whatsapp:+9198…' → '+9198…'. Only the first media item is passed on.
export function toInboundEvent(params: Record<string, string>): InboundEvent {
  const hasMedia = Number(params.NumMedia ?? "0") > 0;
  return {
    channel: "whatsapp",
    from_phone: (params.From ?? "").replace(/^whatsapp:/i, ""),
    text: params.Body ? params.Body : null,
    media_url: hasMedia ? (params.MediaUrl0 ?? null) : null,
    media_type: hasMedia ? (params.MediaContentType0 ?? null) : null,
    latitude: numberOrNull(params.Latitude),
    longitude: numberOrNull(params.Longitude),
    received_at: new Date().toISOString(),
    twilio_message_sid: params.MessageSid ?? null,
  };
}

export type ForwardResult = { via: "agenticorg" | "email" | "none"; status: number | null; error: string | null };

// Which route to use: INBOUND_FORWARD_MODE if set, otherwise whichever one has its settings filled in.
function forwardMode(): ForwardResult["via"] {
  const mode = process.env.INBOUND_FORWARD_MODE;
  if (mode === "agenticorg" || mode === "email" || mode === "none") return mode;
  if (process.env.AGENTICORG_WEBHOOK_URL) return "agenticorg";
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD && process.env.JANUS_INBOX_EMAIL) return "email";
  return "none";
}

// Route 1: AgenticOrg's "run workflow" API, POST /api/v1/workflows/{id}/run with { payload: event }.
// AGENTICORG_API_KEY (an `ao_sk_…` key with workflows:run scope) is sent as a Bearer token if set.
async function forwardToAgenticOrg(event: InboundEvent): Promise<ForwardResult> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (process.env.AGENTICORG_API_KEY) headers.authorization = `Bearer ${process.env.AGENTICORG_API_KEY}`;
  const res = await fetch(process.env.AGENTICORG_WEBHOOK_URL!, {
    method: "POST",
    headers,
    body: JSON.stringify({ payload: event }),
    signal: AbortSignal.timeout(20_000),
  });
  const error = res.ok ? null : `HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`;
  return { via: "agenticorg", status: res.status, error };
}

// Route 2 (fallback): email the event as JSON to the Janus Gmail inbox, which AgenticOrg's
// "Email Received" trigger watches. Sent through Gmail SMTP with an App Password.
async function forwardByEmail(event: InboundEvent): Promise<ForwardResult> {
  const transport = nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
  await transport.sendMail({
    from: `Janus WhatsApp relay <${process.env.GMAIL_USER}>`,
    to: process.env.JANUS_INBOX_EMAIL,
    subject: `[janus-inbound] WhatsApp from ${event.from_phone}`,
    text: JSON.stringify(event, null, 2),
  });
  return { via: "email", status: 250, error: null };
}

export async function forwardEvent(event: InboundEvent): Promise<ForwardResult> {
  const via = forwardMode();
  try {
    if (via === "agenticorg") return await forwardToAgenticOrg(event);
    if (via === "email") return await forwardByEmail(event);
    return { via, status: null, error: "No forwarding configured (set AGENTICORG_WEBHOOK_URL or the GMAIL_* variables)." };
  } catch (err) {
    return { via, status: null, error: (err as Error).message };
  }
}
