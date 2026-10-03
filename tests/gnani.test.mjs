// Part of tests/run-all.mjs (npm test). Run alone: node --env-file=.env.local tests/gnani.test.mjs [base-url]
const base = process.argv[2] ?? "http://localhost:3000";
const key = process.env.MCP_API_KEY;
let passed = 0, failed = 0;
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log("PASS", label); }
  else { failed++; console.log("FAIL", label, "\n     ", JSON.stringify(detail).slice(0, 500)); }
};
async function rpc(path, method, params, withKey = true) {
  const res = await fetch(`${base}${path}`, { method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(withKey ? { "x-api-key": key } : {}), "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (res.status !== 200) return { status: res.status };
  const line = (await res.text()).split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(line.slice(6)).result;
}
// Gnani rate-limits bursts of calls; like Janus should, wait and retry once.
const gnani = async (name, args) => {
  const call = async () => (await rpc("/gnani/mcp", "tools/call", { name, arguments: args })).structuredContent;
  const first = await call();
  if (first?.error_code !== "GNANI_RATE_LIMITED") return first;
  console.log("      (Gnani rate limit hit; waiting 15 s and retrying once)");
  await new Promise((r) => setTimeout(r, 15_000));
  return call();
};
const core = async (name, args) => (await rpc("/janus-core/mcp", "tools/call", { name, arguments: args })).structuredContent;

check("no key -> 401", (await rpc("/gnani/mcp", "tools/list", {}, false)).status === 401);
const list = await rpc("/gnani/mcp", "tools/list", {});
check("2 tools listed", list.tools?.map((t) => t.name).sort().join() === "gnani_speech_to_text,gnani_text_to_speech", list);

const marathi = "नमस्कार प्रिया, रमेश उद्या संध्याकाळी पाच वाजता येईल.";
let r = await gnani("gnani_text_to_speech", { text: marathi, language: "mr-IN" });
check(`TTS Marathi -> Blob URL (voice ${r.voice}, ${r.bytes} bytes, ${r.took_ms} ms)`, r.ok && r.voice === "Zahira" && r.audio_url?.includes(".public.blob.vercel-storage.com/tts/"), r);
const url = r.audio_url;
const audioRes = await fetch(url);
const head = Buffer.from(await audioRes.arrayBuffer()).subarray(0, 4).toString("latin1");
check("audio_url is public and is OGG", audioRes.ok && audioRes.headers.get("content-type") === "audio/ogg" && head === "OggS", { status: audioRes.status, ct: audioRes.headers.get("content-type"), head });

r = await gnani("gnani_speech_to_text", { media_url: url, language_hint: "mr-IN" });
console.log("      mr-IN transcript:", r.text);
check("STT Marathi round trip", r.ok && r.text.includes("रमेश") && r.language_detected === null && r.confidence === null && r.partner === "Gnani", r);
r = await gnani("gnani_speech_to_text", { media_url: url, language_hint: "hi-IN" });
console.log("      same audio as hi-IN:", r.text, "(returned as-is, never corrected)");
check("STT with hi-IN hint still answers", r.ok && typeof r.text === "string", r);

r = await gnani("gnani_text_to_speech", { text: "Priya ji, Ramesh kal shaam paanch baje aayega, theek hai?", language: "hi-en" });
check(`TTS Hinglish -> voice ${r.voice}`, r.ok && r.voice === "Poorvi", r);
r = await gnani("gnani_text_to_speech", { text: "test", language: "mr-IN", voice: "Nalini" });
check("wrong voice for language -> INVALID_VOICE", r.error_code === "INVALID_VOICE" && r.voices_for_language.includes("Ishaan"), r);
r = await gnani("gnani_speech_to_text", { media_url: "https://example.com/evil.ogg" });
check("unknown host -> INVALID_MEDIA_URL", r.error_code === "INVALID_MEDIA_URL", r);
r = await gnani("gnani_speech_to_text", { media_url: url.replace(/\/tts\/[^/]+$/, "/tts/does-not-exist.ogg") });
check("missing file -> MEDIA_DOWNLOAD_FAILED", r.error_code === "MEDIA_DOWNLOAD_FAILED", r);
r = await gnani("gnani_speech_to_text", { media_url: url, language_hint: "xx-YY" });
check("bad language -> INVALID_INPUT", r.error_code === "INVALID_INPUT", r);

await core("scenario_set", { key: "gnani.next_stt", value: "malformed" });
r = await gnani("gnani_speech_to_text", { media_url: url });
check("switch malformed -> GNANI_MALFORMED_RESPONSE", r.error_code === "GNANI_MALFORMED_RESPONSE" && r.simulated, r);
await core("scenario_set", { key: "gnani.next_stt", value: "low_confidence" });
r = await gnani("gnani_speech_to_text", { media_url: url });
check("switch low_confidence -> real text + confidence 0.31", r.ok && r.confidence === 0.31 && r.text.length > 0, r);
await core("scenario_set", { key: "gnani.next_tts", value: "timeout" });
let t0 = Date.now();
r = await gnani("gnani_text_to_speech", { text: "hello", language: "en-IN" });
const waited = Date.now() - t0;
check(`switch timeout -> GNANI_TIMEOUT after ${waited} ms (< 10000)`, r.error_code === "GNANI_TIMEOUT" && waited >= 5500 && waited < 10000, r);
r = await gnani("gnani_text_to_speech", { text: "Your technician is on the way.", language: "en-IN" });
check("switch used up -> next call normal", r.ok && r.voice === "Kaveri", r);

console.log(`\n${passed} passed, ${failed} failed`);
