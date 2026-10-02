// Telnyx realtime transcription over the streaming WebSocket endpoint.
//
// Frame protocol verified live 2026-10-01 and 2026-09-03 (telnyx-oss-contribution
// skill reference):
// - Audio goes up as raw binary frames (16-bit little-endian, mono PCM by default).
// - Config is passed as URL query params, NOT a config frame: a post-connect JSON
//   config frame is silently ignored.
// - The Telnyx engine (in-house) emits exactly ONE final transcript frame after
//   audio stops: {"transcript": "...", "confidence": null, "is_final": true}. No
//   interims, no word timestamps, no speech_started. The socket stays open after
//   the final (2026-09-03 behavior) and does NOT accept CloseStream (that is for
//   Deepgram/Speechmatics/Soniox).
// - Other engines proxied by the same endpoint (Deepgram, Speechmatics, Soniox,
//   plus 8 more) emit interim frames and expect a {"type":"CloseStream"} on close.
// - Engine names are case-sensitive; unsupported values return a structured
//   {"errors":[...]} frame.
// Docs: https://developers.telnyx.com/docs/api/v2/speech-to-text
import process from "node:process";

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  PluginCapabilityCatalogContext,
  RealtimeTranscriptionProviderPlugin,
} from "openclaw/plugin-sdk/plugin-entry";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import {
  asFiniteNumber,
  asOptionalRecord,
  normalizeOptionalString as trimToUndefined,
} from "openclaw/plugin-sdk/string-coerce-runtime";

export const DEFAULT_TELNYX_STT_BASE_URL = "wss://api.telnyx.com/v2/speech-to-text/transcription";
export const DEFAULT_TELNYX_STT_SAMPLE_RATE = 16_000;
export const DEFAULT_TELNYX_STT_ENGINE = "Telnyx";
/** Engines verified live 2026-09-03 via the endpoint's own error frame. */
export const TELNYX_STT_ENGINES = [
  "AssemblyAI",
  "Azure",
  "Cohere",
  "Deepgram",
  "Google",
  "Humain",
  "Parakeet",
  "Reson8",
  "Soniox",
  "Speechmatics",
  "Telnyx",
  "xAI",
] as const;
/** Engines that close via {"type":"CloseStream"}; the Telnyx engine does not. */
const CLOSE_STREAM_ENGINES = new Set(["Deepgram", "Speechmatics", "Soniox"]);

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;
const DEFAULT_RECONNECT_DELAY_MS = 1000;
const DEFAULT_MAX_QUEUED_BYTES = 2 * 1024 * 1024;

// Session/transport shapes derived from the SDK's own capability catalog context
// so this file stays type-aligned with whatever SDK version is installed.
type SttSessionFactory = PluginCapabilityCatalogContext["createRealtimeTranscriptionWebSocketSession"];
type SessionOptions = Parameters<SttSessionFactory>[0];
type SessionCallbacks = NonNullable<SessionOptions["callbacks"]>;
type SttTransport = Parameters<NonNullable<SessionOptions["onMessage"]>>[1];
type SttSession = ReturnType<SttSessionFactory>;

export type RealtimeTranscriptionProviderConfig = Record<string, unknown>;
export type RealtimeTranscriptionSessionCreateRequest = SessionCallbacks & {
  cfg?: OpenClawConfig;
  providerConfig: RealtimeTranscriptionProviderConfig;
};

export type TelnyxSttProviderConfig = {
  apiKey?: string;
  baseUrl?: string;
  engine: string;
  sampleRate: number;
  inputFormat: "linear16" | "mulaw" | "alaw";
  language?: string;
  interimResults?: boolean;
};

function readNestedTelnyxSttConfig(rawConfig: RealtimeTranscriptionProviderConfig) {
  const raw = asOptionalRecord(rawConfig);
  const providers = asOptionalRecord(raw?.providers);
  return asOptionalRecord(providers?.telnyx ?? raw?.telnyx ?? raw) ?? {};
}

export function normalizeTelnyxSttConfig(
  rawConfig: RealtimeTranscriptionProviderConfig,
): TelnyxSttProviderConfig {
  const raw = readNestedTelnyxSttConfig(rawConfig);
  const engine = (trimToUndefined(raw.engine) ?? process.env.TELNYX_STT_ENGINE ?? DEFAULT_TELNYX_STT_ENGINE).trim();
  const matched = TELNYX_STT_ENGINES.find((candidate) => candidate.toLowerCase() === engine.toLowerCase());
  if (!matched) {
    throw new Error(
      `Invalid Telnyx STT engine "${engine}": supported engines are ${TELNYX_STT_ENGINES.join(", ")}`,
    );
  }
  const inputFormat = trimToUndefined(raw.inputFormat)?.toLowerCase();
  const normalizedFormat: TelnyxSttProviderConfig["inputFormat"] =
    inputFormat === "linear16" || inputFormat === "pcm" || inputFormat === "pcm_s16le"
      ? "linear16"
      : inputFormat === "ulaw" || inputFormat === "g711_ulaw"
        ? "mulaw"
        : inputFormat === "alaw" || inputFormat === "g711_alaw"
          ? "alaw"
          : "linear16";
  if (
    inputFormat &&
    !["linear16", "pcm", "pcm_s16le", "ulaw", "g711_ulaw", "mulaw", "alaw", "g711_alaw"].includes(inputFormat)
  ) {
    throw new Error(
      `Invalid Telnyx STT inputFormat: "${inputFormat}" (expected linear16, mulaw, or alaw)`,
    );
  }
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw.apiKey,
      path: "stt.providers.telnyx.apiKey",
    }),
    baseUrl: trimToUndefined(raw.baseUrl),
    engine: matched,
    sampleRate: asFiniteNumber(raw.sampleRate ?? raw.sample_rate) ?? DEFAULT_TELNYX_STT_SAMPLE_RATE,
    inputFormat: normalizedFormat,
    language: trimToUndefined(raw.language),
    interimResults: raw.interimResults === true || raw.interim_results === true,
  };
}

export function buildSttUrl(config: TelnyxSttProviderConfig): string {
  const url = new URL(config.baseUrl?.trim() || DEFAULT_TELNYX_STT_BASE_URL);
  url.searchParams.set("transcription_engine", config.engine);
  url.searchParams.set("input_format", config.inputFormat);
  url.searchParams.set("sample_rate", String(config.sampleRate));
  // language is intentionally omitted unless configured: it can suppress output
  // on the Telnyx engine (verified 2026-08-04); empty transcripts are silence.
  if (config.language) {
    url.searchParams.set("language", config.language);
  }
  if (config.interimResults) {
    // Ignored by the Telnyx engine (2026-09-03), which never emits interims;
    // meaningful for proxied engines such as Deepgram.
    url.searchParams.set("interim_results", "true");
  }
  return url.toString();
}

export type SttFrameHandler = (frame: unknown, transport: SttTransport) => void;

export type SttTurnState = {
  finalizedTranscript: string;
  speechStarted: boolean;
};

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function joinTranscript(left: string, right: string): string {
  const l = collapseWhitespace(left);
  const r = collapseWhitespace(right);
  return l && r ? `${l} ${r}` : l || r;
}

/**
 * Frames are parsed by keys. The Telnyx engine emits one final with
 * confidence:null; the Deepgram engine adds speech_final. Empty transcripts are
 * silence and are skipped.
 */
export function createSttFrameHandler(params: {
  callbacks: SessionCallbacks;
  state: SttTurnState;
  retainedBytesLimit?: number;
}): SttFrameHandler {
  const { callbacks, state } = params;
  const retainedBytesLimit = params.retainedBytesLimit ?? 256 * 1024;
  return (frame, transport) => {
    if (typeof frame !== "object" || frame === null) return;
    const record = frame as Record<string, unknown>;
    if (Array.isArray(record.errors) && record.errors.length > 0) {
      const first = record.errors[0];
      const detail =
        typeof first === "object" && first !== null && "detail" in first
          ? trimToUndefined((first as Record<string, unknown>).detail)
          : undefined;
      callbacks.onError?.(new Error(detail ?? "Telnyx STT error"));
      transport.closeNow();
      return;
    }
    const transcript = typeof record.transcript === "string" ? record.transcript : "";
    if (!transcript.trim()) return;
    if (!state.speechStarted) {
      state.speechStarted = true;
      callbacks.onSpeechStart?.();
    }
    if (record.is_final === true || record.speech_final === true) {
      const nextFinalized = joinTranscript(state.finalizedTranscript, transcript);
      if (Buffer.byteLength(nextFinalized, "utf8") > retainedBytesLimit) {
        callbacks.onError?.(new Error(`Telnyx realtime transcript exceeded ${retainedBytesLimit} bytes`));
        transport.closeNow();
        return;
      }
      state.finalizedTranscript = nextFinalized;
      callbacks.onTranscript?.(nextFinalized);
      return;
    }
    // Interim frame: surfaced as a partial preview. The Telnyx engine never
    // emits these; proxied engines such as Deepgram do when interim_results=true.
    callbacks.onPartial?.(joinTranscript(state.finalizedTranscript, transcript));
  };
}

export function resolveTelnyxSttApiKey(params: {
  cfg?: OpenClawConfig;
  providerConfig: TelnyxSttProviderConfig;
}): string | undefined {
  if (params.providerConfig.apiKey) return params.providerConfig.apiKey;
  const env = process.env.TELNYX_API_KEY?.trim();
  if (env) return env;
  const models = asOptionalRecord(asOptionalRecord(params.cfg)?.models);
  const telnyx = asOptionalRecord(asOptionalRecord(models?.providers)?.telnyx);
  const fallback = trimToUndefined(telnyx?.apiKey);
  return fallback
    ? normalizeResolvedSecretInputString({
        value: fallback,
        path: "models.providers.telnyx.apiKey",
      })
    : undefined;
}

export function buildTelnyxRealtimeTranscriptionProvider({
  createRealtimeTranscriptionWebSocketSession,
}: Pick<
  PluginCapabilityCatalogContext,
  "createRealtimeTranscriptionWebSocketSession"
>): RealtimeTranscriptionProviderPlugin {
  return {
    id: "telnyx",
    label: "Telnyx Realtime Transcription",
    aliases: ["telnyx-stt"],
    defaultModel: DEFAULT_TELNYX_STT_ENGINE,
    models: TELNYX_STT_ENGINES,
    autoSelectOrder: 40,
    resolveConfig: ({ rawConfig }) => normalizeTelnyxSttConfig(rawConfig),
    isConfigured: ({ cfg, providerConfig }) =>
      Boolean(resolveTelnyxSttApiKey({ cfg, providerConfig: normalizeTelnyxSttConfig(providerConfig) })),
    createSession: (req): SttSession => {
      const config = normalizeTelnyxSttConfig(req.providerConfig);
      const apiKey = resolveTelnyxSttApiKey({ cfg: req.cfg, providerConfig: config });
      if (!apiKey) {
        throw new Error("Telnyx API key missing for speech-to-text");
      }
      const state: SttTurnState = { finalizedTranscript: "", speechStarted: false };
      const handleFrame = createSttFrameHandler({ callbacks: req, state });
      return createRealtimeTranscriptionWebSocketSession({
        providerId: "telnyx",
        callbacks: req,
        url: buildSttUrl(config),
        headers: { Authorization: `Bearer ${apiKey}` },
        readyOnOpen: true,
        connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
        closeTimeoutMs: DEFAULT_CLOSE_TIMEOUT_MS,
        maxReconnectAttempts: DEFAULT_MAX_RECONNECT_ATTEMPTS,
        reconnectDelayMs: DEFAULT_RECONNECT_DELAY_MS,
        maxQueuedBytes: DEFAULT_MAX_QUEUED_BYTES,
        connectTimeoutMessage: "Telnyx realtime transcription connection timeout",
        connectClosedBeforeReadyMessage: "Telnyx realtime transcription connection closed before ready",
        reconnectLimitMessage: "Telnyx realtime transcription reconnect limit reached",
        sendAudio: (audio, transport) => {
          transport.sendBinary(audio);
        },
        onClose: (transport) => {
          if (CLOSE_STREAM_ENGINES.has(config.engine)) {
            transport.sendJson({ type: "CloseStream" });
          }
          // The Telnyx engine flushes and stays open on its own; no close frame.
        },
        onMessage: (event, transport) => handleFrame(event, transport),
      });
    },
  };
}
