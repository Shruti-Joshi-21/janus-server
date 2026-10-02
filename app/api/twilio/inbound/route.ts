import { after } from "next/server";
import { validateRequest } from "twilio/lib/webhooks/webhooks";
import { sql, toDbValue } from "@/lib/db";
import { forwardEvent, toInboundEvent } from "@/lib/inbound";

// Twilio calls this for every incoming WhatsApp message (Console → WhatsApp sandbox → "When a message comes in").
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';

// The exact public URL Twilio signed. Vercel passes the original host/protocol in x-forwarded-* headers.
function publicUrl(req: Request): string {
  if (process.env.TWILIO_WEBHOOK_URL) return process.env.TWILIO_WEBHOOK_URL;
  const url = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  return `${proto}://${host}${url.pathname}${url.search}`;
}

export async function POST(req: Request) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    console.error("[twilio] TWILIO_AUTH_TOKEN is not set");
    return new Response("Server not configured", { status: 500 });
  }

  const form = await req.formData();
  const params: Record<string, string> = {};
  for (const [key, value] of form.entries()) params[key] = String(value);

  // 1. Only accept requests Twilio really sent.
  const signature = req.headers.get("x-twilio-signature") ?? "";
  if (!validateRequest(authToken, signature, publicUrl(req), params)) {
    console.warn("[twilio] rejected: bad signature for", publicUrl(req));
    return new Response("Invalid Twilio signature", { status: 403 });
  }

  // 2. Convert and 3. store a copy. A repeat delivery of the same MessageSid is stored once and forwarded once.
  const event = toInboundEvent(params);
  const [stored] = await sql`
    INSERT INTO inbound_events (channel, from_phone, text, media_url, media_type, latitude, longitude, received_at, twilio_message_sid, raw)
    VALUES (${event.channel}, ${event.from_phone}, ${event.text}, ${event.media_url}, ${event.media_type},
            ${event.latitude}, ${event.longitude}, ${event.received_at}, ${event.twilio_message_sid}, ${toDbValue(params)}::jsonb)
    ON CONFLICT (twilio_message_sid) DO NOTHING
    RETURNING id`;

  // 4. Forward to Janus after replying, so Twilio gets its answer immediately and doesn't retry.
  if (stored) {
    after(async () => {
      const result = await forwardEvent(event);
      if (result.error) console.error("[twilio] forward failed", result);
      await sql`
        UPDATE inbound_events SET forward_via = ${result.via}, forward_status = ${result.status}, forward_error = ${result.error}
        WHERE id = ${stored.id}`;
    });
  }

  return new Response(EMPTY_TWIML, { headers: { "content-type": "text/xml" } });
}
