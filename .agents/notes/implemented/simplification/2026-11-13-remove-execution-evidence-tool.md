# Agent Note: Remove the standalone execution evidence model tool

Status: implemented

## Problem

The owner questioned the extra model-facing receipt retrieval tool and requested its removal if public competitors had no matching standalone design. Public competitor mechanisms are not identical: Claude Code removed TaskOutput in v2.1.277 in favor of Read on background output files; Codex has running-session output and optional rollout reads; OpenCode retains long outputs in files. This is not proof that competitors lack recovery mechanisms.

## Decision

Remove the builtin model tool, Service registration, defaults, explore-role allowance, public factory export, and prompts requiring it. Do not create a replacement tool. Keep host scoped receipt queries, original execution records, unknown outcomes, idempotency and historical result rendering. The old factory exists only in a test fixture to exercise legacy data compatibility.

## Alternatives considered

- Keep the model tool: stronger recovery when all references disappear, but contrary to the owner's simplification request.
- Replace it with another broad retrieval tool: merely renames the surface the owner asked to remove.
- Delete underlying records: loses audit and recovery evidence and is not authorized by removing a model tool.

## Consequences

With both receipt references and bodies absent from the model window, there is no general model-facing task-wide receipt enumeration. Existing permitted readers work only with retained references; plans and file state do not reconstruct attribution. Missing evidence must remain missing/unknown, not trigger replay or success claims. Controlled tests can show storage survives compaction and no host replay occurs, but cannot prove arbitrary real models never repeat effects. Legacy fixture tests are not current product capability tests.

Current behavior and test links: [host receipt boundary](../../../../packages/agent/src/business/execution-evidence/README.md).
