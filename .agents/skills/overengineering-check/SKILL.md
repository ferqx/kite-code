---
name: overengineering-check
description: Review a completed implementation phase before marking it done, and identify speculative compatibility, duplicate authority or state, unused abstractions, and operational machinery that exceed verified product requirements.
---

# Check a phase for overengineering

Run this check before marking an explicit implementation phase or task tranche complete, and once more over the full diff before final handoff. It does not expand the user's requested scope or replace correctness, security, documentation, or release gates.

1. Restate the phase's required outcome and non-goals from the user's instruction and current authority. Judge mechanisms against that boundary, not against hypothetical future requirements.
2. Inspect the phase diff and trace every new process, persistent file/table/key, protocol operation, lifecycle state, recovery path, abstraction layer, compatibility branch, configuration option, feature flag, and dedicated test matrix to a production caller or an explicit accepted requirement.
3. Use repository search to distinguish real consumers from tests and documentation. A mechanism referenced only by its own tests/docs, a migration for an unreleased format, or a fallback without a supported predecessor is a removal or deferral candidate.
4. Check that one-time migration, repair, and cleanup logic is not coupled to ordinary startup or request paths. Normal read/status operations must not create credentials, sessions, files, database facts, or recovery state.
5. Prefer an existing owner and transaction boundary over a second registry, queue, lease, cache, locator, or coordination root. Do not add a generic framework when a local function or direct composition satisfies the current requirement.
6. Preserve complexity that has a concrete correctness, data-loss, security, concurrency, or supported-platform reason. File count or line count alone is not evidence of overengineering.
7. Classify findings as:
   - `required`: directly justified and retained;
   - `simplify_now`: unnecessary for the current outcome and safe to remove in this phase;
   - `defer`: plausible future need with no current implementation authority.
8. If any material `simplify_now` item remains, keep the phase `in_progress`, remove or narrow it, rerun affected tests, and repeat this check. Mark the phase complete only when remaining complexity is `required` or explicitly deferred without scaffolding.

Report a compact phase result:

```text
Phase: <name>
Required: <retained mechanisms and evidence>
Simplify now: <removed or still-blocking items>
Deferred: <future needs with no current scaffolding>
Decision: pass | revise
```
