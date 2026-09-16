# OpenClaw Telnyx Provider

Official Telnyx-maintained AI inference provider plugin for OpenClaw. It connects OpenClaw to Telnyx's OpenAI-compatible chat completions API and supports live model discovery.

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
