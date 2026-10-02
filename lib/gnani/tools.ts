import type { McpServer } from "@modelcontextprotocol/server";
import { put } from "@vercel/blob";
import { z } from "zod";
import { addTool, ToolError } from "@/lib/mcp";
import { sleep, takeScenario, TIMEOUT_DELAY_MS } from "@/lib/scenarios";
import { speechToText, STT_LANGUAGES, textToSpeech, TTS_LANGUAGES, VOICES } from "./client";

const MAX_AUDIO_BYTES = 5 * 1024 * 1024; // a 60-second WhatsApp voice note is well under 1 MB

// Only fetch audio from places we expect, so the tool can't be pointed at arbitrary URLs.
function allowedMediaHost(url: URL): "twilio" | "blob" | null {
  if (url.protocol !== "https:") return null;
  if (url.hostname === "api.twilio.com" || url.hostname.endsWith(".twilio.com")) return "twilio";
  if (url.hostname.endsWith(".public.blob.vercel-storage.com")) return "blob";
  return null;
}

// Twilio media URLs need the account's basic auth; Twilio then redirects to the file (auth is not forwarded).
async function downloadAudio(mediaUrl: string): Promise<{ audio: Buffer; contentType: string }> {
  let url: URL;
  try {
    url = new URL(mediaUrl);
  } catch {
    throw new ToolError("INVALID_MEDIA_URL", `"${mediaUrl}" is not a URL.`);
  }
  const host = allowedMediaHost(url);
  if (!host) throw new ToolError("INVALID_MEDIA_URL", "media_url must be an https Twilio media URL (from the incoming message) or a janus-audio Blob URL.");

  const headers: Record<string, string> = {};
  if (host === "twilio") {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) throw new ToolError("SERVER_MISCONFIGURED", "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are not set on the server.");
    headers.authorization = `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`;
  }

  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(4000) });
  } catch (err) {
    throw new ToolError("MEDIA_DOWNLOAD_FAILED", `Could not download the voice note: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new ToolError(
      "MEDIA_DOWNLOAD_FAILED",
      res.status === 404 ? "The voice note no longer exists (Twilio media may have been deleted)." : `Downloading the voice note failed with HTTP ${res.status}.`,
      { http_status: res.status },
    );
  }
  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  if (!contentType.startsWith("audio/") && !contentType.startsWith("video/")) {
    throw new ToolError("UNSUPPORTED_MEDIA_TYPE", `That media is ${contentType}, not audio. Only voice notes can be transcribed.`);
  }
  const audio = Buffer.from(await res.arrayBuffer());
  if (audio.length > MAX_AUDIO_BYTES) throw new ToolError("MEDIA_TOO_LARGE", "The voice note is larger than 5 MB.");
  return { audio, contentType };
}

export function registerGnaniTools(server: McpServer) {
  addTool(
    server,
    "gnani_speech_to_text",
    "Transcribe a WhatsApp voice note with Gnani. Pass the media_url from the incoming message and the household's language. Returns Gnani's transcript exactly as given (never corrected). Gnani does not report the detected language or a confidence score, so those are null. Max 60 seconds of audio. Note: Gnani may push Marathi toward Hindi and can stumble on mid-sentence code-switching; if the text looks wrong, ask the household to confirm.",
    z.object({
      media_url: z.string().describe("MediaUrl0 from the incoming WhatsApp message (Twilio), or a janus-audio Blob URL"),
      language_hint: z.enum(STT_LANGUAGES).default("mr-IN").describe("Language spoken. Pune households: mr-IN (Marathi), hi-IN (Hindi), en-IN (English)"),
    }),
    async ({ media_url, language_hint }) => {
      const scenario = await takeScenario("gnani.next_stt");
      if (scenario === "timeout") {
        await sleep(TIMEOUT_DELAY_MS);
        throw new ToolError("GNANI_TIMEOUT", "Gnani did not answer in time (simulated by scenario switch).", { http_status: 504, simulated: true });
      }
      if (scenario === "malformed") {
        throw new ToolError("GNANI_MALFORMED_RESPONSE", "Gnani's reply was not valid JSON (simulated by scenario switch).", { raw: "<html>502 Bad Gateway", simulated: true });
      }

      const { audio, contentType } = await downloadAudio(media_url);
      const started = Date.now();
      const result = await speechToText(audio, contentType, language_hint);
      return {
        text: result.transcript,
        language_detected: null,
        confidence: scenario === "low_confidence" ? 0.31 : null,
        ...(scenario === "low_confidence" ? { simulated: true, warning: "Low confidence (simulated by scenario switch): confirm with the household." } : {}),
        empty: result.transcript.trim() === "",
        language_used: language_hint,
        gnani_request_id: result.request_id,
        gnani_model: result.model,
        audio_bytes: audio.length,
        took_ms: Date.now() - started,
        partner: "Gnani",
      };
    },
  );

  addTool(
    server,
    "gnani_text_to_speech",
    `Turn text into a WhatsApp voice note with Gnani (OGG/Opus) and return a public audio_url to send as media. language: ${TTS_LANGUAGES.join(", ")} ('hi-en' = Hinglish). Default voices: Marathi Zahira, Hindi Nalini, English Kaveri, Hinglish Poorvi.`,
    z.object({
      text: z.string().min(1).max(1000),
      language: z.enum(TTS_LANGUAGES),
      voice: z.string().optional().describe("A Gnani voice for that language, e.g. mr-IN: Zahira (f), Ishaan (m)"),
      speed: z.number().min(0.85).max(1.15).default(1.0),
    }),
    async ({ text, language, voice, speed }) => {
      const scenario = await takeScenario("gnani.next_tts");
      if (scenario === "timeout") {
        await sleep(TIMEOUT_DELAY_MS);
        throw new ToolError("GNANI_TIMEOUT", "Gnani did not answer in time (simulated by scenario switch).", { http_status: 504, simulated: true });
      }
      if (scenario === "malformed") {
        throw new ToolError("GNANI_MALFORMED_RESPONSE", "Gnani did not return OGG audio (simulated by scenario switch).", { simulated: true });
      }

      const chosenVoice = voice ?? VOICES[language][0];
      if (voice && !VOICES[language].includes(voice)) {
        throw new ToolError("INVALID_VOICE", `${voice} is not a ${language} voice.`, { voices_for_language: VOICES[language] });
      }
      if (!process.env.BLOB_READ_WRITE_TOKEN) throw new ToolError("SERVER_MISCONFIGURED", "BLOB_READ_WRITE_TOKEN is not set on the server.");

      const started = Date.now();
      const audio = await textToSpeech(text, language, chosenVoice, speed);
      const blob = await put(`tts/${language}-${chosenVoice}.ogg`, audio, {
        token: process.env.BLOB_READ_WRITE_TOKEN, // explicit, so the library doesn't try Vercel OIDC instead
        access: "public",
        contentType: "audio/ogg",
        addRandomSuffix: true,
      });
      return {
        audio_url: blob.url,
        content_type: "audio/ogg",
        bytes: audio.length,
        language,
        voice: chosenVoice,
        took_ms: Date.now() - started,
        partner: "Gnani",
      };
    },
  );
}
