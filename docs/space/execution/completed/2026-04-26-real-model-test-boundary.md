# Completed: Real Model Test Boundary

Date: 2026-04-26
Status: completed
Related active rule: `../active/real-model-test-boundary.md`

## Change

Moved the real DeepSeek end-to-end suite out of Bun default test discovery and
fixed the explicit real-test scripts.

Implementation shape:

- Renamed `tests/real-agent.test.ts` to `tests/real-agent.real.ts`.
- Updated `test:real` to pass the suite as an explicit Bun path:
  `./tests/real-agent.real.ts`.
- Removed the proxy-unsetting `test:real:direct` variant. Project scripts
  should respect the caller's proxy environment.
- Removed the package-level `--timeout`; the real suite sets per-test timeouts
  next to the scenarios that need them.
- Added `tests/test-discovery.test.ts` to assert:
  - default test files do not include `real` suites;
  - default test files do not directly call `createDeepSeekModel(...)`;
  - explicit real-test scripts point at `./tests/real-agent.real.ts`.
- Updated `README.md` and `AGENTS.md` so default tests and real model tests are
  separate workflows.

## Rationale

The real DeepSeek suite depends on credentials, network reachability, and local
proxy behavior. It should never run as part of a bare `bun test`.

After renaming the file to `.real.ts`, Bun requires the package script to pass
the file as an explicit path using `./tests/real-agent.real.ts`. Without the
leading `./`, Bun treats it as a filter and reports that no test files match.

Proxy cleanup is an environment concern, not a project-script default. Some
local and CI environments need proxies to reach DeepSeek; others need proxies
disabled. The script should not force either choice.

## Verification

Validated with:

```bash
bun test tests/test-discovery.test.ts
bun run test:real
bun test
bun run typecheck
git diff --check
```
