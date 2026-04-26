# Reference: OpenAI Harness Engineering

Status: reference
Source: https://openai.com/zh-Hans-CN/index/harness-engineering/
Read date: 2026-04-26
Related local records:

- `../index.md`
- `../understanding/space-system-design.md`

## Summary

OpenAI's Codex harness engineering article frames the repository as the primary
record system for agent work. The important local lesson is not to add more
prompt text, but to make the repository easier for agents to navigate, inspect,
verify, and maintain.

Key takeaways for this repository:

- `AGENTS.md` should stay a compact map, not a large manual.
- Durable knowledge belongs in a structured docs tree with indexes and links.
- Durable plans and execution records should be first-class versioned artifacts.
- Agents should use progressive disclosure: start from a stable entry point and
  follow links to relevant details.
- Documentation needs freshness and garbage-collection rules; stale records are
  worse than missing records when agents treat them as current.
- Generated material needs explicit downgrade boundaries until promoted into an
  active local rule.

## Local Implications

`docs/space/` should provide:

- `README.md` as a short entry point.
- `index.md` as the catalog and status view.
- `execution/active/` for current implementation constraints.
- `execution/completed/` for historical change records and verification.
- `references/` for non-binding external summaries.
- `generated/` for derived material that must not silently become policy.

This reference supports the rule that later agents should read the index first
and then read only records whose scope matches the task.

For this repository, that does not mean writing every runtime
`graph.state.plan` to a file. The checkpoint remains the source of truth for
per-run plan state; `docs/space` records durable design decisions around that
behavior.
