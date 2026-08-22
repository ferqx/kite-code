# RAV1-02 Grant/Receipt authenticity

状态：completed

范围：在真实持久化与进程外边界增加 authenticated envelope 与 child-frame verifier；同进程 typed `ExecutionGrant`/`ExecutionReceipt` 继续使用 schema、identity equality 与 single-use 约束，不包装虚假 HMAC。

实现：`packages/runtime-spi/src/authority-envelope.ts` 定义 canonical envelope/frame schema；`packages/runtime-host/src/authority-boundary.ts` 提供 domain-separated HMAC、issuer/key-id 校验、expiry、monotonic sequence、single-use nonce 与 revocation。

Gate：`bun test packages/runtime-host/test/authority-boundary.test.ts`（3 passed，覆盖 tamper、wrong domain、wrong issuer/key identity、expiry、revoke、nonce replay、frame replay 与 cross-invocation）；runtime-spi/runtime-host typecheck 通过。

约束：Grant/Receipt payload 不承载 secret；envelope 与 frame 使用独立 domain；该阶段未改变 State 25、Store 4、当前 epoch 或生产 dispatch owner。
