// Telnyx TTS synthesis over the streaming WebSocket endpoint.
//
// Frame protocol verified live 2026-10-01 (matches the 2026-09-01 capture in the
// telnyx-oss-contribution skill reference):
// - Server frames carry NO "type" field: parse by keys ("audio", "isFinal", "error", "cached").
// - Synthesis starts on flush/teardown; isFinal:true arrives ONLY after the
//   teardown frame {"text":""}. There is no per-utterance final, so the clean
//   request/response shape is one connection per utterance. Synthesis outpaces
//   playback ~2.4x (verified 2026-09-01), so per-utterance dialing adds no
//   audible latency.
// - Audio arrives as base64 PCM (linear16) in the "audio" key. Cache-status
//   frames ({"audio":null,"cached":false,...}) carry no audio and are skipped.
// Docs: https://developers.telnyx.com/docs/voice/tts/websocket-streaming
import process from "node:process";

export const DEFAULT_TELNYX_TTS_BASE_URL = "wss://api.telnyx.com/v2/text-to-speech/speech";
export const DEFAULT_TELNYX_TTS_SAMPLE_RATE = 16_000;
export const DEFAULT_TELNYX_TTS_VOICE = "Telnyx.Bayan.Amanda";

/** Voices verified against the standalone streaming WS on a Telnyx API key. */
export const TELNYX_VERIFIED_VOICES = [
  "Telnyx.Bayan.Amanda",
  "Telnyx.Qwen3TTS.d9348e0d-988a-42cc-a64e-18093fe45c03",
  "Telnyx.KokoroTTS.af_alloy",
] as const;

/** Voices directory response is account-gated; point config errors at it. */
export const TELNYX_VOICES_ENDPOINT = "https://api.telnyx.com/v2/text-to-speech/voices";

const WAV_HEADER_BYTES = 44;
const INIT_TEXT = " ";
const TEARDOWN_TEXT = "";

export function wrapPcmToWav(
  pcm: Buffer,
  sampleRate: number,
  channels = 1,
  bitsPerSample = 16,
): Buffer {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE((sampleRate * channels * bitsPerSample) / 8, 28);
  header.writeUInt16LE((channels * bitsPerSample) / 8, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export type ParsedTtsFrame =
  | { kind: "audio"; audio: Buffer }
  | { kind: "final" }
  | { kind: "cache-status" }
  | { kind: "error"; message: string };

/** Parses one server frame by its keys. Frames carry no "type" field. */
export function parseTtsFrame(data: unknown): ParsedTtsFrame | undefined {
  if (typeof data === "string") {
    try {
      data = JSON.parse(data) as unknown;
    } catch {
      return undefined;
    }
  }
  if (typeof data !== "object" || data === null) return undefined;
  const frame = data as Record<string, unknown>;
  if (typeof frame.error === "string" && frame.error.trim()) {
    return { kind: "error", message: frame.error };
  }
  if (frame.isFinal === true && typeof frame.audio !== "string") return { kind: "final" };
  if (typeof frame.audio === "string" && frame.audio.length > 0) {
    try {
      return { kind: "audio", audio: Buffer.from(frame.audio, "base64") };
    } catch {
      return { kind: "error", message: "Telnyx TTS sent a non-base64 audio payload" };
    }
  }
  if (frame.cached !== undefined) return { kind: "cache-status" };
  return undefined;
}

export function buildTtsUrl(params: { voice: string; sampleRate: number; baseUrl?: string }): string {
  const url = new URL(params.baseUrl?.trim() || DEFAULT_TELNYX_TTS_BASE_URL);
  url.searchParams.set("voice", params.voice);
  url.searchParams.set("audio_format", "linear16");
  url.searchParams.set("sample_rate", String(params.sampleRate));
  return url.toString();
}

type TtsSocket = {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(type: "error", listener: (event: { message?: string }) => void): void;
};

export type TtsWebSocketFactory = (
  url: string,
  options: { headers: Record<string, string> },
) => TtsSocket;

// Node's global WebSocket (undici) accepts handshake headers via WebSocketInit;
// the DOM lib declaration in tsconfig scopes only offers the string[] overload,
// so the constructor is re-typed structurally here. Verified live 2026-10-01.
type NativeWebSocketConstructor = new (
  url: string | URL,
  options?: { headers?: Record<string, string> },
) => TtsSocket;

function defaultWebSocketFactory(url: string, options: { headers: Record<string, string> }): TtsSocket {
  const NativeWebSocket = (globalThis as { WebSocket: NativeWebSocketConstructor }).WebSocket;
  return new NativeWebSocket(url, { headers: options.headers });
}

export type TelnyxTtsSynthesisResult = {
  pcm: Buffer;
  sampleRate: number;
};

/**
 * Synthesizes one utterance: dial -> init -> text(+flush) -> teardown -> collect
 * audio until isFinal. Verified 2026-09-01/2026-10-01: flushed text streams
 * audio immediately; teardown yields the only isFinal marker, then the server
 * closes (1000 OK).
 */
export function synthesizeTelnyxTts(params: {
  text: string;
  apiKey: string;
  voice: string;
  sampleRate?: number;
  voiceSpeed?: number;
  baseUrl?: string;
  timeoutMs: number;
  webSocketFactory?: TtsWebSocketFactory;
}): Promise<TelnyxTtsSynthesisResult> {
  const sampleRate = params.sampleRate ?? DEFAULT_TELNYX_TTS_SAMPLE_RATE;
  const url = buildTtsUrl({ voice: params.voice, sampleRate, baseUrl: params.baseUrl });
  const factory = params.webSocketFactory ?? defaultWebSocketFactory;
  return new Promise<TelnyxTtsSynthesisResult>((resolve, reject) => {
    let settled = false;
    let receivedFinal = false;
    const chunks: Buffer[] = [];
    let socket: TtsSocket | undefined;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        socket?.close();
      } catch {
        // Socket already closed; nothing to tear down.
      }
      if (error) {
        reject(error);
        return;
      }
      resolve({ pcm: Buffer.concat(chunks), sampleRate });
    };

    const timeout = setTimeout(() => {
      finish(new Error(`Telnyx TTS timed out after ${params.timeoutMs}ms (voice: ${params.voice})`));
    }, Math.max(params.timeoutMs, 1));

    try {
      socket = factory(url, { headers: { Authorization: `Bearer ${params.apiKey}` } });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    socket.addEventListener("open", () => {
      socket?.send(JSON.stringify({ text: INIT_TEXT, voice_settings: { voice_speed: params.voiceSpeed ?? 1 } }));
      socket?.send(JSON.stringify({ text: params.text, flush: true }));
      socket?.send(JSON.stringify({ text: TEARDOWN_TEXT }));
    });

    socket.addEventListener("message", (event) => {
      const parsed = parseTtsFrame(event.data);
      if (!parsed) return;
      switch (parsed.kind) {
        case "audio": {
          chunks.push(parsed.audio);
          return;
        }
        case "final": {
          receivedFinal = true;
          finish();
          return;
        }
        case "cache-status": {
          // Cache-status notification carries no audio payload; not an error.
          return;
        }
        case "error": {
          finish(new Error(`Telnyx TTS error: ${parsed.message}`));
          return;
        }
      }
    });

    socket.addEventListener("close", () => {
      if (!receivedFinal) {
        finish(new Error(`Telnyx TTS closed before synthesis completed (voice: ${params.voice})`));
      }
    });

    socket.addEventListener("error", (event) => {
      finish(
        new Error(
          `Telnyx TTS connection failed (voice: ${params.voice}): ${event.message ?? "unknown WebSocket error"}`,
        ),
      );
    });
  });
}
