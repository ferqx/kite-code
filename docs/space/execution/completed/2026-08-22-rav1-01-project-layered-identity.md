# RAV1-01 Project 与分层 Identity

状态：completed

日期：2026-08-22

范围：在 RAV1-00 authority/threat model 之后，冻结 ProjectIdentityStore、Host-issued ProjectHandle 与 Session/Environment/Provider/Credential/Artifact 分层 identity schema；不实施 Grant/Receipt authenticity、DataOrigin/Egress、fence 或新持久化格式。

实现：`packages/runtime-spi/src/identity.ts` 提供最小分层 schema 与 canonical identity JSON；`packages/runtime-host/src/project-identity.ts` 提供 installation-scoped resolve-or-create、临时文件原子发布、lock-directory race 串行化、handle issuance 与 fail-closed verification。

Gate：`bun test packages/runtime-host/test/project-identity.test.ts`（3 passed）；`bun run --cwd packages/runtime-spi typecheck`；`bun run --cwd packages/runtime-host typecheck`。Fixtures 覆盖 canonical repeat resolve、workspace move、handle tamper/stale 与 two-instance race。

约束：ProjectHandle 只用于 CreateSession identity resolution，不代表 execution authorization；各层 identity 不折叠为 monolithic composition digest。生产仍为 State 25、Store 4 与 `kite-runtime-2026-08-18` epoch。
