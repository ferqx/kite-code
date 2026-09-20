# Prompt contract

System-prompt changes must preserve these enforceable runtime constraints:

- Complex planning work reads/searches before proposing a structural plan.
- A reviewed plan enters execution; structural revisions request review again.
- `ask_user` uses one canonical `questions` array; when the user requests multiple decisions, that
  single call contains every requested question instead of sending the first and promising the rest.
  It remains available in full mode, especially while clarifying a plan.
- Destructive shell and unapproved network/VCS mutation remain policy-gated.
- Planning cannot run non-read-only shell work, and no prompt can bypass the sandbox.
- Independent delegated siblings are dispatched together with `background=true`; required results
  keep the current Run open and Runtime-managed waiting replaces model-driven `sleep` or repeated
  `task_read` polling. Only separately authorized `after_turn` delivery may outlive the current Run.

Add a rule by documenting the user-observable behavior here and adding a focused test in
`tests/prompts/`. Prompt prose is not a security boundary; policy tests are authoritative.
