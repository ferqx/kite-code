# Prompt contract

System-prompt changes must preserve these enforceable runtime constraints:

- Complex planning work reads/searches before proposing a structural plan.
- A reviewed plan enters execution; structural revisions request review again.
- `ask_user` requires a question and either options or free text; full mode does not request it.
- Destructive shell and unapproved network/VCS mutation remain policy-gated.
- Planning cannot run non-read-only shell work, and no prompt can bypass the sandbox.

Add a rule by documenting the user-observable behavior here and adding a focused test in `src/core/prompts/tests/`. Prompt prose is not a security boundary; policy tests are authoritative.
