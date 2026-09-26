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
  `task_read` polling. `task_wait` is for an intermediate first-result decision; when only required
  children remain, the model submits its final candidate and Runtime waits in the same Run.
  `task_read` retrieves a full truncated report or supports a specific status/diagnostic query.
  `shell_read` uses its returned cursor for later output. These rules do not globally prohibit
  legitimate shell commands that use `sleep`. Only separately authorized `after_turn` delivery may
  outlive the current Run.
- When disclosed by the Host mailbox owner, Agent communication uses stable `agent_id` while
  task control uses exact `task_id`. `send_message` queues only; `followup_task` asks for
  continuation and returns empty success after durable admission, not execution. `wait_agent`
  returns a bounded wake reason for the caller's mailbox; model input receives messages as
  lower-trust Agent frames, not user instructions or approvals.

Add a rule by documenting the user-observable behavior here and adding a focused test in
`tests/prompts/`. Prompt prose is not a security boundary; policy tests are authoritative.
