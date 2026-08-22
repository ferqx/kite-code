# RAV1-03 DataOrigin、Egress 与 Credential

状态：completed

范围：增加 provenance 与 egress authority IR，并把 Builtin context fragments 的 observation origin 贯穿到 compiled payload；CredentialHandle 保持 opaque、purpose-bound，secret 不进入 Grant/Receipt/Event/Notification。

实现：`packages/runtime-spi/src/data-origin-egress.ts` 定义 DataOrigin、deny-wins classification、destination-specific EgressAuthority 与 CredentialBroker contract；`packages/builtin-runtime/src/model-context.ts` 为 project/user/external observation fragment 生成 origin metadata。

Gate：`bun test packages/runtime-spi/test/data-origin-egress.test.ts`（2 passed）；runtime-spi 与 builtin-runtime typecheck 通过。覆盖 confidential/secret deny-wins、destination authority、origin-kind denial 与 expiry。

约束：现有 MCP credential vault 与 egress permit 行为保持不变；Model 与 MCP 不共享 nonce namespace；后续 operation-specific adapters 只能复用该 IR，不得建立第二 egress owner。
