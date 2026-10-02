// Thin client for Gnani's Vachana REST APIs (docs: https://docs.gnani.ai/api/introduction/introduction).
// Verified against the live API on 2026-10-03.
import { ToolError } from "@/lib/mcp";

const STT_URL = "https://api.vachana.ai/stt/v3";
const TTS_URL = "https://api.vachana.ai/api/v1/tts/inference";
const GNANI_TIMEOUT_MS = 7000; // AgenticOrg gives a tool 10 s in total

export const STT_LANGUAGES = ["mr-IN", "hi-IN", "en-IN", "bn-IN", "gu-IN", "kn-IN", "ml-IN", "pa-IN", "ta-IN", "te-IN"] as const;
export const TTS_LANGUAGES = [...STT_LANGUAGES, "hi-en", "auto"] as const;

// Voices from https://docs.gnani.ai/api/TTS/available-voices. Default first.
export const VOICES: Record<string, string[]> = {
  "mr-IN": ["Zahira", "Ishaan"],
  "hi-IN": ["Nalini", "Deepak", "Ambuja", "Bhavna", "Chitra", "Hemraj", "Jalaj", "Jwala", "Omkar", "Roopesh", "Urmila", "Vikrant", "Yashvi"],
  "en-IN": ["Kaveri", "Devika", "Girish", "Pranav", "Shlok", "Trupti"],
  "hi-en": ["Poorvi"],
  "auto": ["Nalini"],
  "bn-IN": ["Kirra", "Dhruva"],
  "gu-IN": ["Falak", "Veera"],
  "kn-IN": ["Saanvi", "Kavin"],
  "ml-IN": ["Reshma", "Riyaan"],
  "pa-IN": ["Mehuli", "Zayan"],
  "ta-IN": ["Trisha", "Asmita", "Brinda", "Noopur", "Vedika"],
  "te-IN": ["Lavanya", "Lehara", "Suhana", "Varuni", "Yukti"],
};

function apiKey(): string {
  const key = process.env.GNANI_API_KEY;
  if (!key) throw new ToolError("SERVER_MISCONFIGURED", "GNANI_API_KEY is not set on the server.");
  return key;
}

// Turn a failed Gnani response into a ToolError with Gnani's own error text.
async function gnaniError(res: Response): Promise<ToolError> {
  const body = await res.text();
  let detail = body.slice(0, 300);
  try {
    const json = JSON.parse(body);
    // Gnani nests its message in different places depending on the error; take the first readable text.
    const candidates = [json.error?.message, json.error, json.message, json.detail?.message, json.detail?.error, json.detail];
    const text = candidates.find((c) => typeof c === "string");
    detail = text ?? JSON.stringify(json).slice(0, 300);
  } catch {
    // not JSON; keep the raw text
  }
  const code = res.status === 401 || res.status === 403 ? "GNANI_AUTH_FAILED" : res.status === 429 ? "GNANI_RATE_LIMITED" : "GNANI_ERROR";
  return new ToolError(code, `Gnani returned HTTP ${res.status}: ${detail}`, { gnani_status: res.status });
}

async function callGnani(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(GNANI_TIMEOUT_MS) });
  } catch (err) {
    if ((err as Error).name === "TimeoutError") {
      throw new ToolError("GNANI_TIMEOUT", `Gnani did not answer within ${GNANI_TIMEOUT_MS / 1000} seconds. Try again or ask the household to type.`, { http_status: 504 });
    }
    throw new ToolError("GNANI_UNREACHABLE", `Could not reach Gnani: ${(err as Error).message}`);
  }
}

export async function speechToText(audio: Buffer, contentType: string, languageCode: string) {
  const form = new FormData();
  const extension = contentType.split("/")[1]?.split(";")[0] || "ogg";
  form.append("audio_file", new Blob([new Uint8Array(audio)], { type: contentType }), `voice-note.${extension}`);
  form.append("language_code", languageCode);
  const res = await callGnani(STT_URL, { method: "POST", headers: { "X-API-Key-ID": apiKey() }, body: form });
  if (!res.ok) throw await gnaniError(res);

  const raw = await res.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ToolError("GNANI_MALFORMED_RESPONSE", "Gnani's reply was not valid JSON.", { raw: raw.slice(0, 200) });
  }
  if (json.success !== true || typeof json.transcript !== "string") {
    throw new ToolError("GNANI_MALFORMED_RESPONSE", "Gnani's reply had no transcript.", { raw: raw.slice(0, 200) });
  }
  return { transcript: json.transcript, request_id: (json.request_id as string) ?? null, model: (json.model as string) ?? null };
}

// Returns an OGG/Opus voice note, the format WhatsApp plays as a voice message.
export async function textToSpeech(text: string, language: string, voice: string, speed: number): Promise<Buffer> {
  const res = await callGnani(TTS_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "X-API-Key-ID": apiKey() },
    body: JSON.stringify({
      text,
      model: "timbre-v2.5",
      voice,
      language,
      speed,
      audio_config: { sample_rate: 48000, num_channels: 1, sample_width: 2, encoding: "oggopus", container: "ogg" },
    }),
  });
  if (!res.ok) throw await gnaniError(res);
  const audio = Buffer.from(await res.arrayBuffer());
  if (audio.subarray(0, 4).toString("latin1") !== "OggS") {
    throw new ToolError("GNANI_MALFORMED_RESPONSE", "Gnani did not return OGG audio.", { bytes: audio.length });
  }
  return audio;
}
