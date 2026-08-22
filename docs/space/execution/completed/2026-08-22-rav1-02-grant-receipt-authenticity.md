# RAV1-02 Grant/Receipt authenticity

状态：qualification_pending

范围：在真实持久化与进程外边界增加 authenticated envelope 与 child-frame verifier；同进程 typed `ExecutionGrant`/`ExecutionReceipt` 继续使用 schema、identity equality 与 single-use 约束，不包装虚假 HMAC。

实现：`packages/runtime-spi/src/authority-envelope.ts` 定义 canonical envelope/frame schema；`packages/runtime-host` 提供 installation-root domain derivation、persisted envelope、POSIX FD bootstrap、MCP-stdio binary bootstrap/wrapper 与严格 frame verifier；Windows runner 使用 stdin bootstrap、跨 TS/Rust canonical frame、authenticated ready→durable ack→GO 和 exact handle ownership。Builtin/App 同进程 seam 不加 HMAC。

本地 Gate：authority/envelope JSON、POSIX real child、MCP stdio real child 与 installed standalone wrapper、Windows TS protocol、tamper/wrong peer/key/domain/issuer/expiry/revoke/replay/unknown/truncated/oversize/pre-ready/cleanup negative suites、full default/typecheck/build 通过。

待闭合：本机没有 Rust/Windows 工具链；必须在受信 final SHA 上完成 cargo fmt/check/test、native build、restricted-token E2E 与 platform probe。3 个 native skip 不能作为通过证据。
