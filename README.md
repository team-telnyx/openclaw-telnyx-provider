# OpenClaw Telnyx Provider

Official Telnyx-maintained AI inference provider plugin for OpenClaw. It connects OpenClaw to Telnyx's OpenAI-compatible chat completions API and supports live model discovery. It also registers Telnyx as a speech provider (text-to-speech) and a realtime transcription provider (speech-to-text), so one Telnyx API key covers models, voice, and transcription.

## Install

Requires OpenClaw `2026.8.1` or newer. Older hosts cannot load this package; run `openclaw update` first.

```bash
openclaw plugins install @telnyx/openclaw-provider
openclaw gateway restart
```

Configure a Telnyx API key during OpenClaw onboarding or export it before starting OpenClaw:

```bash
export TELNYX_API_KEY="<TELNYX_API_KEY>"
```

See [the Telnyx provider guide](https://docs.openclaw.ai/providers/telnyx) for model selection, authentication, and configuration.

## Speech (text-to-speech)

The plugin registers a `telnyx` TTS provider that streams over the Telnyx TTS WebSocket (`wss://api.telnyx.com/v2/text-to-speech/speech`) and returns WAV audio. Voice notes are transcoded to Opus automatically.

Configuration lives under `tts.providers.telnyx`; when no key is set there, the provider falls back to `TELNYX_API_KEY`, then to the `telnyx` inference provider key:

```json
{
  "tts": {
    "provider": "telnyx",
    "providers": {
      "telnyx": {
        "voice": "Telnyx.Bayan.Amanda",
        "sampleRate": 16000,
        "voiceSpeed": 1.0
      }
    }
  }
}
```

- `voice`: any voice id from the Telnyx catalog (`https://api.telnyx.com/v2/text-to-speech/voices`, 4,600+ voices across eleven providers). Default `Telnyx.Bayan.Amanda`. Voice availability is account-gated; unavailable voices fail the WebSocket handshake with an error that names the voices directory.
- `sampleRate`: output sample rate in Hz (default `16000`).
- `voiceSpeed`: 0.5 to 2.0 (default `1.0`, sent as `voice_speed`).
- `baseUrl`: override the WebSocket endpoint (for proxies or staging).

## Realtime transcription (speech-to-text)

The plugin registers a `telnyx` realtime transcription provider over `wss://api.telnyx.com/v2/speech-to-text/transcription`. Twelve engines are available through the same endpoint; the default is Telnyx's in-house engine.

The Telnyx engine emits exactly one final transcript after audio stops (no interim frames). For interim results, switch the engine (for example `Deepgram`) and enable `interimResults`.

The provider is consumed by OpenClaw voice surfaces. Talk selects it with `talk.provider` and reads per-provider settings from `talk.providers.telnyx`; voice calls read `plugins.entries.voice-call.config.streaming.providers.telnyx`:

```json
{
  "talk": {
    "providers": {
      "telnyx": {
        "engine": "Telnyx",
        "inputFormat": "linear16",
        "sampleRate": 16000
      }
    }
  }
}
```

- `engine`: `AssemblyAI`, `Azure`, `Cohere`, `Deepgram`, `Google`, `Humain`, `Parakeet`, `Reson8`, `Soniox`, `Speechmatics`, `Telnyx`, or `xAI` (case-sensitive).
- `inputFormat`: `linear16`, `mulaw`, or `alaw` (default `linear16`).
- `sampleRate`: input sample rate in Hz (default `16000`).
- `language`: BCP-47 tag. Omitted unless configured; setting it can suppress output on the Telnyx engine.
- `interimResults`: enable interim frames for engines that support them (default `false`).

## Development

Requirements:

- Node.js supported by the current OpenClaw release
- npm

Install dependencies, build the compiled plugin, and run unit tests:

```bash
npm install
npm run build
npm test
```

Inspect the package contents before publishing:

```bash
npm pack --dry-run
```

Live tests require valid Telnyx credentials and explicit opt-in:

```bash
TELNYX_LIVE_TEST=1 OPENCLAW_LIVE_TEST=1 npm run test:live
```

## Maintenance

Maintained by the Telnyx AI Integrations team. Issues and pull requests are tracked in this repository.

## License

MIT
