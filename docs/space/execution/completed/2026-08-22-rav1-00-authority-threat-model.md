# RAV1-00 Authority Contract 与 Threat Model 完成记录

状态：completed

日期：2026-08-22

权威来源：accepted Runtime Modularization RFC、ADR-0123/0124/0125、
`2026-08-20-kite-runtime-authority-format-v1-implementation.md`

前置证据：`2026-08-22-rmv1-16-static-domain-reducers-legacy-closure.md`

Implementation final SHA：`8a2b54cd84dbb43cbf926ce77e79fd220e57b5f7`

## 交付结论

RAV1-00 已冻结唯一 authority sequence、同进程可信域、attacker classes、真实
serialization/execution boundary 与当前 key custody：

- Authority 顺序固定为 Proposal → Kernel Intent → Required Authority → approval decision → durable Grant → execution materialization → attempt acknowledgement → external dispatch → bounded Receipt → Mailbox fact → Kernel receipt acceptance；
- 同进程可信域严格为 Agent Kernel、Runtime Host 与 Builtin Runtime，继续使用 typed schema、exact identity 与 process-local single-use，不增加虚假 HMAC 隔离；
- 机械清单固定 12 个真实边界，覆盖 Runtime Store、私有 Artifact、POSIX/Windows sandbox protocol、MCP HTTP/stdio、Model transport、Credential vault 与非权威 Client notification；
- 所有 authority carrier 固定 `secretMaterialAllowed=false`；恶意可信同进程代码、已攻陷 OS/Kernel 与任意内存读取明确不属于 V1 attacker model；
- Runtime Store、POSIX/Windows sandbox frame 与 MCP stdio 的 issuer、canonical bytes、key/domain、rotation、revocation 延后到 RAV1-02，RAV1-00 不提前选择算法或创建真实性实现。

## 格式与行为保持

- Production Runtime State 保持 schema `25`，Store 保持 schema `4`，epoch 保持 `kite-runtime-2026-08-18`；
- 没有改变 production dispatch、Grant/Receipt 发行、Session restore、Event replay、Artifact storage 或 Provider 行为；
- 没有创建 ProjectIdentity、State 26、Store 5、新 epoch、cross-Host fence、DataOrigin/Egress/Credential rewrite；
- 已删除的 evaluation、record/replay response source、cassette 与相关 CI 没有恢复。

## Gate 证据

| Gate | 结果 |
| --- | --- |
| RAV1-00 boundary/attacker/key-custody fixtures | passed；9 tests、16 expects、0 fail |
| `packages/runtime-spi` typecheck/build/full tests | passed；45 tests、249 expects、15 modules |
| `bun run typecheck` | passed；根 TypeScript 与 7 workspace |
| `bun run check:runtime-packages` | passed；7 package、12 edge、唯一 `apps/kite/src/bootstrap.ts` composition root |
| `bun run check:core-boundary` | passed |
| `bun run check:docs-impact`、`bun run check:docs` | passed |
| `bun run scripts/check-runtime-modularization-manifests.ts` | passed；State25、Store4、旧 epoch、29 operation、0 architecture exception |
| `bun run format:check`、`bun run lint` | passed；18 条既有 warning、0 error |
| 正常 pre-commit hooks | passed；未使用 `--no-verify` |

## 阶段裁决

RAV1-00 完成定义与自动 Gate 已闭合，本记录绑定上列 implementation final SHA。下一阶段为 RAV1-01，只能在本 threat model 上增加 Project identity 与分层 identity schema；不得提前实施 Grant/Receipt authenticity、State26、Store5 或 production format cutover。
