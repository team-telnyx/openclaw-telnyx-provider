// Capability catalog entry for the Telnyx plugin: speech (TTS) and realtime
// transcription (STT) providers. Default export; synchronous.
import type { PluginCapabilityCatalogEntry } from "openclaw/plugin-sdk/plugin-entry";

import { buildTelnyxRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";
import { buildTelnyxSpeechProvider } from "./speech-provider.js";

const catalog: PluginCapabilityCatalogEntry = (context) => ({
  speechProviders: [buildTelnyxSpeechProvider(context)],
  realtimeTranscriptionProviders: [buildTelnyxRealtimeTranscriptionProvider(context)],
});

export default catalog;
