# Real-model E2E suites

This directory is reserved for explicit real-model end-to-end suites.

There is currently no maintained real-model test. A future suite must:

- use a `*.live.ts` filename;
- select provider and model from isolated environment configuration;
- be a standalone runner invoked with `bun run` through an explicit package script and opt-in environment guard;
- run serially with a bounded timeout;
- redact credentials, complete prompts, requests and user configuration;
- document the provider, model, date, network conditions and command used for any reported result.

Mock model, public MCP-only and local transport tests do not belong in this directory.
