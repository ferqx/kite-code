# Real-model E2E suites

This directory contains explicit, opt-in real-model end-to-end suites. Run the maintained context
compaction suite with:

```bash
KITE_RUN_LIVE_MODEL_COMPACTION=1 \
KITE_LIVE_MODEL_API_KEY=... \
KITE_LIVE_MODEL_BASE_URL=https://provider.example/v1 \
KITE_LIVE_MODEL_NAME=model-name \
bun run test:model:live
```

Set `KITE_LIVE_MODEL_PROVIDER_TYPE=deepseek` only for a DeepSeek-compatible endpoint. The runner
has a bounded timeout, runs two Provider calls serially, and reports identifiers but no prompts,
requests, summaries, configuration, or credentials. Every suite must:

- use a `*.live.ts` filename;
- select provider and model from isolated environment configuration;
- be a standalone runner invoked with `bun run` through an explicit package script and opt-in environment guard;
- run serially with a bounded timeout;
- redact credentials, complete prompts, requests and user configuration;
- document the provider, model, date, network conditions and command used for any reported result.

Mock model, public MCP-only and local transport tests do not belong in this directory.

## Verification record

- 2026-07-22, provider `deepseek`, model `deepseek-v4-flash`, normal network conditions.
- Command: `bun run test:model:live` with the opt-in variables populated from the local Kite Code
  configuration.
- Result: `manual-direct-summary` and `incremental-summary` passed. No request or response body was
  retained in this record.
