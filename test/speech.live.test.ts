// Telnyx speech live tests exercise the real speech endpoints (env-gated, same
// policy as test/telnyx.live.test.ts).
import { describe, expect, it } from "vitest";

import { buildTelnyxRealtimeTranscriptionProvider } from "../src/realtime-transcription-provider.js";
import { buildTelnyxSpeechProvider } from "../src/speech-provider.js";

const LIVE_VALUE = process.env.TELNYX_API_KEY?.trim() ?? "";
const LIVE =
  process.env.OPENCLAW_LIVE_TEST === "1" &&
  process.env.TELNYX_LIVE_TEST === "1" &&
  LIVE_VALUE.length > 0;
const describeLive = LIVE ? describe : describe.skip;

async function buildLiveContext() {
  const sdk = await import("openclaw/plugin-sdk/realtime-transcription-session");
  return {
    isProviderApiKeyConfigured: () => true,
    isProviderAuthProfileConfigured: () => false,
    createRealtimeTranscriptionWebSocketSession: sdk.createRealtimeTranscriptionWebSocketSession,
  } as never;
}

describeLive("telnyx speech live", () => {
  it(
    "synthesizes speech and round-trips it through the Telnyx STT engine",
    { timeout: 60_000 },
    async () => {
      const context = await buildLiveContext();
      const text = "Hello world, this is a Telnyx speech provider live test.";
      const speech = buildTelnyxSpeechProvider(context);
      const result = await speech.synthesize({
        text,
        cfg: {} as never,
        providerConfig: {},
        target: "file",
        timeoutMs: 45_000,
      });
      expect(result.outputFormat).toBe("wav");
      expect(result.audioBuffer.subarray(0, 4).toString()).toBe("RIFF");
      expect(result.audioBuffer.length).toBeGreaterThan(1000);

      const stt = buildTelnyxRealtimeTranscriptionProvider(context);
      let received: string | undefined;
      const session = stt.createSession({
        providerConfig: {},
        onTranscript: (transcript) => {
          received = transcript;
        },
      } as never);
      await session.connect();
      const pcm = result.audioBuffer.subarray(44);
      for (let offset = 0; offset < pcm.length; offset += 3200) {
        session.sendAudio(pcm.subarray(offset, Math.min(offset + 3200, pcm.length)));
      }
      await new Promise((resolve) => setTimeout(resolve, 4000));
      session.close();
      expect(received?.trim().length ?? 0).toBeGreaterThan(0);
      expect(received?.toLowerCase()).toContain("hello world");
    },
  );
});
