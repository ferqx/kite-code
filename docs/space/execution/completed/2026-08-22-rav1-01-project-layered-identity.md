# RAV1-01 Project 与分层 Identity

状态：superseded by ADR-0127；ProjectIdentityStore/ProjectHandle 已从 production 删除

日期：2026-08-22

范围：在 RAV1-00 authority/threat model 之后，把 ProjectIdentityStore、Host-issued ProjectHandle 与分层 identity 接入真实 CLI/TUI CreateSession composition。

实现：`packages/runtime-spi/src/identity.ts` 提供最小分层 schema；`packages/runtime-host/src/project-identity.ts` 提供 canonical realpath Workspace digest、strict JSON codec、owner-only/no-follow/durable publication、installation-scoped resolve-or-create 与 verify-before-create；`apps/kite/src/bootstrap/project-identity-composition.ts` 是唯一 production composition。CreateSession 必须携带 Host-issued ProjectHandle，Client 不能提交任意 project/workspace identity，Handle 不代表 execution grant。

本地 Gate：Host identity/bridge、CLI/TUI composition、canonical alias/symlink、corruption/unknown field、move/race/clone/stale/expiry fixtures，以及 full default/TUI/typecheck/build 均通过。Runtime installation key、key id 与 handle authenticator 已按用户裁决删除。

完成证据：implementation SHA `604db49d0d32e55bc6761e181856967759cbbb1e`；[Platform Capability Probe 32587639601](https://github.com/ferqx/kite-code/actions/runs/32587639601)、[OSS Release Candidate 32587641939](https://github.com/ferqx/kite-code/actions/runs/32587641939) 与 [Runtime Resilience Qualification 32587644604](https://github.com/ferqx/kite-code/actions/runs/32587644604) 均绑定该 SHA 并成功，正式 7 case × 8 measured report 及独立 verifier 已通过。
