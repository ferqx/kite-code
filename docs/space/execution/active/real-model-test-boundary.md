# Active: Real Model Test Boundary

Date: 2026-04-26
Status: active
Scope: Test discovery, package scripts, real model end-to-end suites
Related completed records:

- `../completed/2026-04-26-remove-internal-ledgers.md`

## Rule

Real model or network end-to-end suites must not be discoverable by a bare
`bun test` run.

Use a non-default suffix for those files, currently:

```text
tests/real-agent.real.ts
```

Run them only through explicit scripts:

```bash
bun run test:real
```

Because `.real.ts` is intentionally outside Bun's default discovery pattern,
package scripts must pass it as an explicit path:

```bash
bun test ./tests/real-agent.real.ts
```

The package script should respect the caller's proxy environment. Do not add a
default `env -u ...proxy...` variant; users can unset or configure proxy
variables outside the project script when their local network requires it.

The real suite sets per-test timeouts in `tests/real-agent.real.ts`, including
longer limits for multi-step agent flows. Do not rely on a package-level
`--timeout` value for this suite.

## Rationale

Default tests should be deterministic and local. The real DeepSeek suite needs
local credentials, reachable network, and a working proxy configuration. When
it used the `*.test.ts` suffix, Bun's default discovery included it in `bun
test`, so ordinary verification failed for environment reasons unrelated to the
code under test.

## Guardrail

`tests/test-discovery.test.ts` asserts that files containing `real` are not
using Bun's default `*.test.*` / `*.spec.*` naming pattern, that default
discovered tests do not directly call `createDeepSeekModel(...)`, and that the
explicit real-test script points at `tests/real-agent.real.ts` without proxy
rewrites.
