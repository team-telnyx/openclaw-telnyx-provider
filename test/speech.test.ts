// Telnyx speech provider unit tests: config normalization, frame parsing, and
// the capability catalog contract. Frame semantics verified live 2026-10-01
// against api.telnyx.com (see src/tts.ts and src/realtime-transcription-provider.ts).
import { describe, expect, it } from "vitest";

import catalog from "../src/capability-catalog.js";
import {
  buildSttUrl,
  createSttFrameHandler,
  normalizeTelnyxSttConfig,
  resolveTelnyxSttApiKey,
  TELNYX_STT_ENGINES,
} from "../src/realtime-transcription-provider.js";
import {
  buildTelnyxSpeechProvider,
  resolveTelnyxSpeechApiKey,
} from "../src/speech-provider.js";
import {
  buildTtsUrl,
  parseTtsFrame,
  synthesizeTelnyxTts,
  wrapPcmToWav,
} from "../src/tts.js";

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe("capability catalog", () => {
  it("exposes validated speech and transcription providers", () => {
    const context = {
      isProviderApiKeyConfigured: () => false,
      isProviderAuthProfileConfigured: () => false,
      createRealtimeTranscriptionWebSocketSession: () => {
        throw new Error("not expected in this test");
      },
    } as never;
    const resolved = (catalog as (ctx: never) => unknown)(context) as {
      speechProviders: unknown[];
      realtimeTranscriptionProviders: Array<Record<string, unknown>>;
    };
    expect(resolved.speechProviders).toHaveLength(1);
    expect(resolved.realtimeTranscriptionProviders).toHaveLength(1);
    for (const family of [resolved.speechProviders, resolved.realtimeTranscriptionProviders]) {
      for (const provider of family as Array<Record<string, unknown>>) {
        expect(typeof provider.id).toBe("string");
        expect(provider.id).toBe("telnyx");
        expect(typeof provider.label).toBe("string");
        expect(typeof provider.isConfigured).toBe("function");
      }
    }
    expect(typeof resolved.realtimeTranscriptionProviders[0]?.createSession).toBe("function");
    const speech = resolved.speechProviders[0] as Record<string, unknown>;
    expect(typeof speech.synthesize).toBe("function");
  });
});

describe("telnyx tts config normalization", () => {
  it("reads the nested tts.providers shape", () => {
    const config = buildTelnyxSpeechProvider({
      isProviderAuthProfileConfigured: () => false,
    }).resolveConfig?.({
      cfg: {} as never,
      rawConfig: {
        providers: {
          telnyx: { apiKey: "cfg-key", voice: "Telnyx.Bayan.Amanda", voiceSpeed: 1.5 },
        },
      },
      timeoutMs: 10_000,
    }) as { apiKey?: string; voice: string; voiceSpeed?: number; sampleRate: number };
    expect(config.apiKey).toBe("cfg-key");
    expect(config.voice).toBe("Telnyx.Bayan.Amanda");
    expect(config.voiceSpeed).toBe(1.5);
    expect(config.sampleRate).toBe(16_000);
  });

  it("falls back to env and models.providers.telnyx apiKey", () => {
    const oldEnv = process.env.TELNYX_API_KEY;
    delete process.env.TELNYX_API_KEY;
    delete process.env.TELNYX_TTS_VOICE;
    try {
      const provider = buildTelnyxSpeechProvider({
        isProviderAuthProfileConfigured: () => false,
      });
      const fromEnv = provider.resolveConfig?.({
        cfg: { models: { providers: { telnyx: { apiKey: "model-key" } } } } as never,
        rawConfig: {},
        timeoutMs: 10_000,
      }) as { voice: string; sampleRate: number };
      expect(fromEnv.voice).toBe("Telnyx.Bayan.Amanda");
      expect(
        resolveTelnyxSpeechApiKey({
          cfg: { models: { providers: { telnyx: { apiKey: "model-key" } } } } as never,
        }),
      ).toBe("model-key");
    } finally {
      restoreEnv("TELNYX_API_KEY", oldEnv);
    }
  });

  it("prefers config apiKey over env", () => {
    const oldEnv = process.env.TELNYX_API_KEY;
    process.env.TELNYX_API_KEY = "env-key";
    try {
      expect(
        resolveTelnyxSpeechApiKey({ configApiKey: "config-key" }),
      ).toBe("config-key");
      expect(resolveTelnyxSpeechApiKey({})).toBe("env-key");
    } finally {
      restoreEnv("TELNYX_API_KEY", oldEnv);
    }
  });

  it("rejects out-of-range voice speed", () => {
    const config = buildTelnyxSpeechProvider({
      isProviderAuthProfileConfigured: () => false,
    }).resolveConfig?.({
      cfg: {} as never,
      rawConfig: { providers: { telnyx: { voiceSpeed: 9 } } },
      timeoutMs: 10_000,
    }) as { voiceSpeed?: number };
    expect(config.voiceSpeed).toBeUndefined();
  });
});

describe("telnyx tts frame parsing", () => {
  it("parses audio, final, cache-status, and error frames by keys", () => {
    expect(
      parseTtsFrame('{"audio":"aGVsbG8=","text":"hi","isFinal":false,"cached":false}'),
    ).toEqual({ kind: "audio", audio: Buffer.from("hello") });
    expect(parseTtsFrame('{"audio":null,"cached":false,"isFinal":false,"text":"x"}')).toEqual({
      kind: "cache-status",
    });
    expect(parseTtsFrame('{"audio":null,"isFinal":true,"text":""}')).toEqual({ kind: "final" });
    expect(parseTtsFrame('{"error":"boom"}')).toEqual({ kind: "error", message: "boom" });
    expect(parseTtsFrame("not json")).toBeUndefined();
    // isFinal with an audio payload must be treated as audio, not as completion.
    expect(parseTtsFrame('{"audio":"aGVsbG8=","isFinal":true}')).toEqual({
      kind: "audio",
      audio: Buffer.from("hello"),
    });
  });

  it("wraps pcm into a parseable wav header", () => {
    const pcm = Buffer.alloc(320);
    pcm.writeUInt32LE(0x646e7361, 4); // marker bytes readable after wrap
    const wav = wrapPcmToWav(pcm, 16_000);
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.subarray(8, 12).toString()).toBe("WAVE");
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(40)).toBe(320);
    expect(wav.length).toBe(364);
  });

  it("builds the tts url with linear16 and sample rate", () => {
    const url = buildTtsUrl({ voice: "Telnyx.Bayan.Amanda", sampleRate: 16_000 });
    expect(url).toContain("voice=Telnyx.Bayan.Amanda");
    expect(url).toContain("audio_format=linear16");
    expect(url).toContain("sample_rate=16000");
  });

  it("completes synthesis on final and skips cache-status frames", async () => {
    const sent: string[] = [];
    let openListener: (() => void) | undefined;
    let messageListener: ((event: { data: unknown }) => void) | undefined;
    const fakeSocket = {
      send: (data: string) => sent.push(data),
      close: () => undefined,
      addEventListener: (type: "open" | "message" | "close" | "error", listener: never) => {
        if (type === "open") openListener = listener as () => void;
        if (type === "message") messageListener = listener as (event: { data: unknown }) => void;
      },
    };
    const promise = synthesizeTelnyxTts({
      text: "hello",
      apiKey: "k",
      voice: "Telnyx.Bayan.Amanda",
      timeoutMs: 5_000,
      webSocketFactory: () => fakeSocket as never,
    });
    openListener?.();
    expect(sent).toEqual([
      JSON.stringify({ text: " ", voice_settings: { voice_speed: 1 } }),
      JSON.stringify({ text: "hello", flush: true }),
      JSON.stringify({ text: "" }),
    ]);
    messageListener?.({ data: '{"audio":null,"cached":false,"isFinal":false,"text":""}' });
    messageListener?.({ data: `{"audio":"${Buffer.from("abc").toString("base64")}","isFinal":false}` });
    messageListener?.({ data: '{"audio":null,"isFinal":true,"text":""}' });
    const result = await promise;
    expect(result.pcm.toString()).toBe("abc");
    expect(result.sampleRate).toBe(16_000);
  });

  it("rejects when the socket closes before final", async () => {
    let closeListener: (() => void) | undefined;
    const fakeSocket = {
      send: () => undefined,
      close: () => undefined,
      addEventListener: (type: "open" | "message" | "close" | "error", listener: never) => {
        if (type === "close") closeListener = listener as () => void;
      },
    };
    const promise = synthesizeTelnyxTts({
      text: "hello",
      apiKey: "k",
      voice: "Telnyx.Bayan.Amanda",
      timeoutMs: 5_000,
      webSocketFactory: () => fakeSocket as never,
    });
    const rejection = expect(promise).rejects.toThrow(/closed before synthesis completed/);
    closeListener?.();
    await rejection;
  });
});

describe("telnyx stt config and url", () => {
  it("normalizes the nested provider shape and validates engines", () => {
    const config = normalizeTelnyxSttConfig({
      providers: {
        telnyx: {
          apiKey: "k",
          engine: "deepgram",
          sampleRate: 8000,
          inputFormat: "ulaw",
          language: "en-US",
        },
      },
    });
    expect(config.engine).toBe("Deepgram");
    expect(config.sampleRate).toBe(8000);
    expect(config.inputFormat).toBe("mulaw");
    expect(config.language).toBe("en-US");
    expect(() => normalizeTelnyxSttConfig({ engine: "bogus" })).toThrow(/supported engines/);
    expect(() => normalizeTelnyxSttConfig({ inputFormat: "gsm" })).toThrow(/expected linear16, mulaw, or alaw/);
  });

  it("lists the verified engines and defaults to Telnyx", () => {
    expect(TELNYX_STT_ENGINES).toContain("Telnyx");
    expect(normalizeTelnyxSttConfig({}).engine).toBe("Telnyx");
  });

  it("builds config as URL params and omits language by default", () => {
    const url = buildSttUrl(normalizeTelnyxSttConfig({}));
    expect(url).toContain("transcription_engine=Telnyx");
    expect(url).toContain("input_format=linear16");
    expect(url).toContain("sample_rate=16000");
    expect(url).not.toContain("language=");
    expect(url).not.toContain("interim_results=");
    const withExtras = buildSttUrl(
      normalizeTelnyxSttConfig({ language: "en-US", interimResults: true }),
    );
    expect(withExtras).toContain("language=en-US");
    expect(withExtras).toContain("interim_results=true");
  });

  it("resolves the api key from config, env, then models.providers", () => {
    const oldEnv = process.env.TELNYX_API_KEY;
    delete process.env.TELNYX_API_KEY;
    try {
      expect(
        resolveTelnyxSttApiKey({ providerConfig: { apiKey: "k" } as never }),
      ).toBe("k");
      expect(
        resolveTelnyxSttApiKey({
          cfg: { models: { providers: { telnyx: { apiKey: "model-key" } } } } as never,
          providerConfig: {} as never,
        }),
      ).toBe("model-key");
    } finally {
      restoreEnv("TELNYX_API_KEY", oldEnv);
    }
  });
});

describe("telnyx stt frame handling", () => {
  const noopTransport = {
    callbacks: {},
    closeNow: () => undefined,
    failConnect: () => undefined,
    isOpen: () => true,
    isReady: () => true,
    markReady: () => undefined,
    sendBinary: () => true,
    sendJson: () => true,
  } as never;

  it("emits exactly one transcript for the Telnyx engine final frame", () => {
    const transcripts: string[] = [];
    const speechStarts: number[] = [];
    const state = { finalizedTranscript: "", speechStarted: false };
    const handler = createSttFrameHandler({
      callbacks: {
        onTranscript: (t) => transcripts.push(t),
        onSpeechStart: () => speechStarts.push(1),
      },
      state,
    });
    handler(
      { transcript: " Hello world, this is a test.", confidence: null, is_final: true },
      noopTransport,
    );
    expect(transcripts).toEqual(["Hello world, this is a test."]);
    expect(speechStarts).toHaveLength(1);
    expect(state.finalizedTranscript).toBe("Hello world, this is a test.");
  });

  it("accumulates finals and surfaces partials for interim engines", () => {
    const transcripts: string[] = [];
    const partials: string[] = [];
    const state = { finalizedTranscript: "", speechStarted: false };
    const handler = createSttFrameHandler({
      callbacks: {
        onTranscript: (t) => transcripts.push(t),
        onPartial: (p) => partials.push(p),
      },
      state,
    });
    handler({ is_final: false, transcript: "Hello, world. This", confidence: 0.9, speech_final: false }, noopTransport);
    handler({ is_final: true, transcript: "Hello, world. This is a test.", confidence: 1.0, speech_final: true }, noopTransport);
    handler({ transcript: "", is_final: true }, noopTransport);
    expect(partials).toEqual(["Hello, world. This"]);
    expect(transcripts).toEqual(["Hello, world. This is a test."]);
    expect(state.finalizedTranscript).toBe("Hello, world. This is a test.");
  });

  it("surfaces structured error frames", () => {
    const errors: string[] = [];
    const state = { finalizedTranscript: "", speechStarted: false };
    const handler = createSttFrameHandler({
      callbacks: { onError: (e) => errors.push(e.message) },
      state,
    });
    handler(
      {
        errors: [
          {
            code: "40007",
            title: "Invalid Parameter",
            source: { parameter: "transcription_engine" },
            detail: "Unsupported transcription_engine 'telnyx'.",
          },
        ],
      },
      noopTransport,
    );
    expect(errors).toEqual(["Unsupported transcription_engine 'telnyx'."]);
  });

  it("guards against unbounded retained transcripts", () => {
    const errors: string[] = [];
    const transcripts: string[] = [];
    const state = { finalizedTranscript: "", speechStarted: false };
    const handler = createSttFrameHandler({
      callbacks: {
        onTranscript: (t) => transcripts.push(t),
        onError: (e) => errors.push(e.message),
      },
      state,
      retainedBytesLimit: 64,
    });
    handler({ transcript: "x".repeat(200), is_final: true }, noopTransport);
    expect(transcripts).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });
});
