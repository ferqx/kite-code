# RAV1-02 Grant/Receipt authenticity

状态：qualification_pending

范围：持久化边界使用 keyless canonical integrity record，进程外边界使用 invocation-local child-frame verifier；同进程 typed `ExecutionGrant`/`ExecutionReceipt` 继续使用 schema、identity equality 与 single-use 约束，不包装 HMAC。

实现：`packages/runtime-spi/src/authority-envelope.ts` 保留 canonical child-frame schema；`packages/runtime-host` 提供 keyless persisted integrity record、POSIX FD bootstrap、MCP-stdio binary bootstrap/wrapper 与严格 frame verifier；Windows runner 使用 stdin bootstrap、跨 TS/Rust canonical frame、ready→durable ack→GO 和 exact handle ownership。frame material 每 invocation 随机生成并在 cleanup 后清零；不存在 installation root。Builtin/App 同进程 seam 不加 HMAC。

本地 Gate：keyless persisted-record strict JSON/integrity/identity negatives、POSIX real child、MCP stdio real child 与 installed standalone wrapper、Windows TS protocol、wrong frame material/peer/domain、replay、unknown/truncated/oversize/pre-ready/cleanup negative suites，以及 full default/TUI/fault/local soak/typecheck/build 通过。

待闭合：本机没有 Rust/Windows 工具链；必须在受信 final SHA 上完成 cargo fmt/check/test、native build、restricted-token E2E 与 platform probe。3 个 native skip 不能作为通过证据。
