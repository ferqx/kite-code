# RAV1-01 Project 与分层 Identity

状态：qualification_pending

日期：2026-08-22

范围：在 RAV1-00 authority/threat model 之后，把 ProjectIdentityStore、Host-issued ProjectHandle 与分层 identity 接入真实 CLI/TUI CreateSession composition。

实现：`packages/runtime-spi/src/identity.ts` 提供最小分层 schema；`packages/runtime-host/src/project-identity.ts` 提供 canonical realpath Workspace digest、strict JSON codec、owner-only/no-follow/durable publication、installation-scoped resolve-or-create 与 verify-before-create；`apps/kite/src/bootstrap/project-identity-composition.ts` 是唯一 production composition。CreateSession 必须携带 Host-issued ProjectHandle，Client 不能提交任意 project/workspace identity，Handle 不代表 execution grant。

本地 Gate：Host identity/bridge、CLI/TUI composition、canonical alias/symlink、corruption/unknown field、move/race/clone/stale/expiry fixtures，以及 full default/TUI/typecheck/build 均通过。Runtime installation key、key id 与 handle authenticator 已按用户裁决删除。

待闭合：implementation commit SHA 与该 SHA 的受信 workflow evidence；完成前不得恢复 completed 标签。
