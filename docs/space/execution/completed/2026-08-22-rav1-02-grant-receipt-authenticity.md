# RAV1-02 Grant/Receipt authenticity

状态：completed

范围：持久化边界使用 keyless canonical integrity record，进程外边界使用 invocation-local child-frame verifier；同进程 typed `ExecutionGrant`/`ExecutionReceipt` 继续使用 schema、identity equality 与 single-use 约束，不包装 HMAC。

实现：`packages/runtime-spi/src/authority-envelope.ts` 保留 canonical child-frame schema；`packages/runtime-host` 提供 keyless persisted integrity record、POSIX FD bootstrap、MCP-stdio binary bootstrap/wrapper 与严格 frame verifier；Windows runner 使用 stdin bootstrap、跨 TS/Rust canonical frame、ready→durable ack→GO 和 exact handle ownership。frame material 每 invocation 随机生成并在 cleanup 后清零；不存在 installation root。Builtin/App 同进程 seam 不加 HMAC。

本地 Gate：keyless persisted-record strict JSON/integrity/identity negatives、POSIX real child、MCP stdio real child 与 installed standalone wrapper、Windows TS protocol、wrong frame material/peer/domain、replay、unknown/truncated/oversize/pre-ready/cleanup negative suites，以及 full default/TUI/fault/local soak/typecheck/build 通过。

完成证据：implementation SHA `604db49d0d32e55bc6761e181856967759cbbb1e`；[Platform Capability Probe 32587639601](https://github.com/ferqx/kite-code/actions/runs/32587639601)、[OSS Release Candidate 32587641939](https://github.com/ferqx/kite-code/actions/runs/32587641939) 与 [Runtime Resilience Qualification 32587644604](https://github.com/ferqx/kite-code/actions/runs/32587644604) 均绑定该 SHA 并成功，正式 7 case × 8 measured report 及独立 verifier 已通过。 Windows job 已实际完成 Cargo 36+7 tests、native build、restricted-token E2E、runner pin 与 probe/verifier；本机 3 个 native skip 未被用作通过证据。
