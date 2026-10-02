// Telnyx speech (TTS) capability for OpenClaw.
//
// The standalone streaming WS accepts every voice in the Telnyx catalog
// (4,657 voices across 11 providers, verified 2026-10-01), so this provider
// exposes the full catalog through one TELNYX_API_KEY. Voices are account-gated
// and Ultra-family voices may 403 at handshake on keys without entitlements; a
// failed handshake surfaces as a connection error pointing at the voices
// directory. The default voice is a Bayan-family voice verified end to end
// through Telnyx STT on 2026-10-01.
import process from "node:process";

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  PluginCapabilityCatalogContext,
  SpeechProviderPlugin,
} from "openclaw/plugin-sdk/plugin-entry";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import {
  asFiniteNumberInRange,
  asOptionalRecord,
  normalizeOptionalString as trimToUndefined,
} from "openclaw/plugin-sdk/string-coerce-runtime";

import {
  DEFAULT_TELNYX_TTS_SAMPLE_RATE,
  DEFAULT_TELNYX_TTS_VOICE,
  TELNYX_VERIFIED_VOICES,
  synthesizeTelnyxTts,
  wrapPcmToWav,
} from "./tts.js";

// Shapes match the SDK's internal speech types exactly (Record<string, unknown>).
type SpeechProviderConfig = Record<string, unknown>;
type SpeechProviderOverrides = Record<string, unknown>;
type DirectiveTokenContext = Parameters<NonNullable<SpeechProviderPlugin["parseDirectiveToken"]>>[0];
type DirectiveTokenResult = ReturnType<NonNullable<SpeechProviderPlugin["parseDirectiveToken"]>>;

const VOICES_CATALOG_URL = "https://api.telnyx.com/v2/text-to-speech/voices";

export type TelnyxTtsProviderConfig = {
  apiKey?: string;
  baseUrl?: string;
  voice: string;
  sampleRate: number;
  voiceSpeed?: number;
};

export type TelnyxTtsProviderOverrides = {
  voice?: string;
  speed?: number;
};

function readProviderConfigRecord(rawConfig: SpeechProviderConfig): Record<string, unknown> {
  const raw = asOptionalRecord(rawConfig);
  const providers = asOptionalRecord(raw?.providers);
  return asOptionalRecord(providers?.telnyx ?? raw?.telnyx ?? raw) ?? {};
}

function normalizeVoiceSpeed(value: unknown): number | undefined {
  return asFiniteNumberInRange(value, { min: 0.5, max: 2 });
}

function normalizeTelnyxTtsProviderConfig(
  rawConfig: SpeechProviderConfig,
  cfg?: OpenClawConfig,
): TelnyxTtsProviderConfig {
  const raw = readProviderConfigRecord(rawConfig);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw.apiKey,
      path: "tts.providers.telnyx.apiKey",
    }),
    baseUrl: trimToUndefined(raw.baseUrl),
    voice:
      trimToUndefined(raw.voice) ??
      trimToUndefined(raw.voiceId) ??
      trimToUndefined(raw.speakerVoice) ??
      trimToUndefined(process.env.TELNYX_TTS_VOICE) ??
      DEFAULT_TELNYX_TTS_VOICE,
    sampleRate:
      asFiniteNumberInRange(raw.sampleRate ?? raw.sample_rate, { min: 8000, max: 48000 }) ??
      DEFAULT_TELNYX_TTS_SAMPLE_RATE,
    voiceSpeed: normalizeVoiceSpeed(raw.voiceSpeed ?? raw.voice_speed ?? raw.speed),
  };
}

function readTelnyxTtsProviderConfig(
  config: SpeechProviderConfig,
  cfg?: OpenClawConfig,
): TelnyxTtsProviderConfig {
  return normalizeTelnyxTtsProviderConfig(config, cfg);
}

function readTelnyxTtsOverrides(
  overrides: SpeechProviderOverrides | undefined,
): TelnyxTtsProviderOverrides {
  if (!overrides) {
    return {};
  }
  return {
    voice: trimToUndefined(overrides.voice ?? overrides.voiceId),
    speed: normalizeVoiceSpeed(overrides.speed),
  };
}

function readModelsProviderApiKey(cfg?: OpenClawConfig): string | undefined {
  const providers = asOptionalRecord(asOptionalRecord(cfg?.models)?.providers);
  const telnyx = asOptionalRecord(providers?.telnyx);
  const value = trimToUndefined(telnyx?.apiKey);
  if (!value) return undefined;
  return normalizeResolvedSecretInputString({
    value,
    path: "models.providers.telnyx.apiKey",
  });
}

/** One-key chain: speech config -> env -> the telnyx inference provider config. */
export function resolveTelnyxSpeechApiKey(params: {
  cfg?: OpenClawConfig;
  configApiKey?: string;
}): string | undefined {
  if (params.configApiKey) return params.configApiKey;
  const env = process.env.TELNYX_API_KEY?.trim();
  if (env) return env;
  return readModelsProviderApiKey(params.cfg);
}

function parseDirectiveToken(ctx: DirectiveTokenContext): DirectiveTokenResult {
  switch (ctx.key) {
    case "voice":
    case "voiceid":
    case "voice_id":
    case "telnyx_voice":
    case "telnyxvoice": {
      if (!ctx.policy.allowVoice) {
        return { handled: true };
      }
      return { handled: true, overrides: { voice: ctx.value } };
    }
    case "speed": {
      // Telnyx exposes this as voice_speed on the TTS init frame.
      return {
        handled: true,
        overrides: { speed: asFiniteNumberInRange(ctx.value, { min: 0.5, max: 2 }) ?? undefined },
      };
    }
    default:
      // Telnyx TTS has no model selector: the voice family picks the model.
      return { handled: false };
  }
}

export function buildTelnyxSpeechProvider({
  isProviderAuthProfileConfigured,
}: Pick<PluginCapabilityCatalogContext, "isProviderAuthProfileConfigured">): SpeechProviderPlugin {
  return {
    id: "telnyx",
    label: "Telnyx",
    aliases: ["telnyx-tts"],
    autoSelectOrder: 30,
    voices: TELNYX_VERIFIED_VOICES,
    resolveConfig: ({ rawConfig, cfg }) => normalizeTelnyxTtsProviderConfig(rawConfig, cfg),
    parseDirectiveToken,
    resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => {
      const base = normalizeTelnyxTtsProviderConfig(baseTtsConfig);
      const talk = readProviderConfigRecord(talkProviderConfig);
      const talkVoiceSpeed = normalizeVoiceSpeed(talk.voiceSpeed ?? talk.voice_speed ?? talk.speed);
      return {
        ...base,
        ...(trimToUndefined(talk.apiKey) == null
          ? {}
          : {
              apiKey: normalizeResolvedSecretInputString({
                value: talk.apiKey,
                path: "talk.providers.telnyx.apiKey",
              }),
            }),
        ...(trimToUndefined(talk.baseUrl) == null ? {} : { baseUrl: trimToUndefined(talk.baseUrl) }),
        ...(trimToUndefined(talk.voice) == null
          ? {}
          : { voice: trimToUndefined(talk.voice) ?? base.voice }),
        ...(asFiniteNumberInRange(talk.sampleRate ?? talk.sample_rate, { min: 8000, max: 48000 }) == null
          ? {}
          : {
              sampleRate:
                asFiniteNumberInRange(talk.sampleRate ?? talk.sample_rate, { min: 8000, max: 48000 }) ??
                base.sampleRate,
            }),
        ...(talkVoiceSpeed == null ? {} : { voiceSpeed: talkVoiceSpeed }),
      };
    },
    resolveTalkOverrides: ({ params }) => ({
      ...(trimToUndefined(params.voiceId) == null ? {} : { voice: trimToUndefined(params.voiceId) }),
      ...(normalizeVoiceSpeed(params.speed) == null ? {} : { speed: normalizeVoiceSpeed(params.speed) }),
    }),
    listVoices: async (req) => {
      const apiKey = resolveTelnyxSpeechApiKey({
        cfg: req.cfg,
        configApiKey: trimToUndefined(req.providerConfig?.apiKey),
      });
      if (!apiKey) {
        throw new Error("Telnyx API key missing for voices lookup");
      }
      const { assertOkOrThrowProviderError } = await import("openclaw/plugin-sdk/provider-http");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), req.timeoutMs ?? 15_000);
      try {
        const response = await fetch(VOICES_CATALOG_URL, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: controller.signal,
        });
        await assertOkOrThrowProviderError(response, "Telnyx voices API error");
        const body = (await response.json()) as { voices?: Record<string, unknown>[] };
        // Catalog response verified 2026-10-01: bare "voices" key (no "data"
        // wrapper), fields id/name/language/provider/gender/hosted.
        return (body.voices ?? []).map((voice) => ({
          id: trimToUndefined(voice.id) ?? "",
          name: trimToUndefined(voice.name),
          category: trimToUndefined(voice.provider),
          locale: trimToUndefined(voice.language),
          gender: trimToUndefined(voice.gender),
        }));
      } finally {
        clearTimeout(timeout);
      }
    },
    isConfigured: ({ cfg, providerConfig }) =>
      Boolean(
        resolveTelnyxSpeechApiKey({
          cfg,
          configApiKey: readTelnyxTtsProviderConfig(providerConfig, cfg).apiKey,
        }),
      ),
    synthesize: async (req) => {
      const config = readTelnyxTtsProviderConfig(req.providerConfig, req.cfg);
      const overrides = readTelnyxTtsOverrides(req.providerOverrides);
      const apiKey = resolveTelnyxSpeechApiKey({ cfg: req.cfg, configApiKey: config.apiKey });
      if (!apiKey) {
        throw new Error("Telnyx TTS auth missing");
      }
      const { pcm, sampleRate } = await synthesizeTelnyxTts({
        text: req.text,
        apiKey,
        voice: overrides.voice ?? config.voice,
        sampleRate: config.sampleRate,
        voiceSpeed: overrides.speed ?? config.voiceSpeed,
        baseUrl: config.baseUrl,
        timeoutMs: req.timeoutMs,
      });
      const wavBuffer = wrapPcmToWav(pcm, sampleRate);
      if (req.target === "voice-note") {
        const { transcodeAudioBufferToOpus } = await import("openclaw/plugin-sdk/media-runtime");
        const opusBuffer = await transcodeAudioBufferToOpus({
          audioBuffer: wavBuffer,
          inputExtension: "wav",
          tempPrefix: "tts-telnyx-",
          timeoutMs: req.timeoutMs,
        });
        return {
          audioBuffer: opusBuffer,
          outputFormat: "opus",
          fileExtension: ".opus",
          voiceCompatible: true,
        };
      }
      return {
        audioBuffer: wavBuffer,
        outputFormat: "wav",
        fileExtension: ".wav",
        voiceCompatible: true,
      };
    },
  };
}
