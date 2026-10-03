// Part of tests/run-all.mjs (npm test). Run alone: npx tsx tests/whatsapp-unit.test.mts
// Pure checks of the WhatsApp/Twilio helpers: no network, no database, no real messages.
import { normalizePhone } from "../lib/phone.ts";
import { AI_DISCLOSURE, buildCallTwiml, escapeXml, mapTwilioError } from "../lib/whatsapp/twilio.ts";

let passed = 0, failed = 0;
const check = (label: string, cond: unknown, detail?: unknown) => {
  if (cond) { passed++; console.log("PASS", label); }
  else { failed++; console.log("FAIL", label, "\n     ", JSON.stringify(detail).slice(0, 400)); }
};

// Error mapping (Twilio code / HTTP status → our error_code)
const cases: [number | null, number | null, string][] = [
  [null, 63015, "NOT_JOINED_SANDBOX"],
  [null, 63016, "OUTSIDE_24H_WINDOW"],
  [400, 21211, "INVALID_PHONE"],
  [401, 20003, "TWILIO_AUTH_FAILED"],
  [401, null, "TWILIO_AUTH_FAILED"],
  [429, null, "TWILIO_RATE_LIMITED"],
  [400, 21610, "TWILIO_ERROR"],
  [500, null, "TWILIO_ERROR"],
];
for (const [http, code, expected] of cases) {
  const e = mapTwilioError(http, code, "msg");
  check(`HTTP ${http} / Twilio ${code} -> ${expected}`, e.code === expected && e.details.twilio_code === code, { code: e.code, details: e.details });
}
const joined = mapTwilioError(null, 63015, null);
check("NOT_JOINED_SANDBOX message tells them how to join", joined.message.includes("+1 415 523 8886") && joined.message.includes("join "), joined.message);
const other = mapTwilioError(400, 21610, "Attempt to send to unsubscribed recipient");
check("TWILIO_ERROR carries Twilio's code and message", other.details.twilio_message === "Attempt to send to unsubscribed recipient" && other.message.includes("21610"), other);

// Call script
const twiml = buildCallTwiml("Please call Priya about the AC repair <today> & confirm.", "hi-IN");
check("call starts with the AI disclosure", twiml.includes(`>${AI_DISCLOSURE} Please call`), twiml);
check("call uses Polly.Aditi in the chosen language", twiml.includes('voice="Polly.Aditi" language="hi-IN"'), twiml);
check("message text is XML-escaped", twiml.includes("&lt;today&gt; &amp; confirm") && !twiml.includes("<today>"), twiml);
check("escapeXml handles quotes", escapeXml(`a"b'c`) === "a&quot;b&apos;c");

// Phone normalisation (same helper every tool uses)
for (const [raw, want] of [["9000000001", "+919000000001"], ["+91 90000 00001", "+919000000001"], ["whatsapp:+918530921384", "+918530921384"], ["12", null]] as const) {
  check(`normalizePhone(${JSON.stringify(raw)}) -> ${want}`, normalizePhone(raw) === want, normalizePhone(raw));
}

console.log(`\n${passed} passed, ${failed} failed`);
