# Agent 生产化 Phase 1B Task 1B.0 完成记录

状态：completed
日期：2026-07-31
计划：
[`2026-07-29-agent-production-execution-isolation.md`](../../plans/2026-07-29-agent-production-execution-isolation.md)
执行者：`github:@ferqx`
实现提交：`bb1a6c7049284723958ca42a417411fac1a76e62`

## 结论

- `PlatformCapabilityEvidenceV1` 固定 OS/version、architecture、Bun、backend、入口、
  filesystem、network、process-tree、inheritance、限制和 canonical digest。
- 技术结论只允许 `supported | read_only_only | excluded`，并固定
  `productionSupported=false`；backend discovery 或 `backend=none` 不能产生进程型支持。
- macOS 15/Seatbelt、Ubuntu 24.04/bubblewrap、Windows Server 2025/none 三个候选均为
  `excluded`。production-supported platform/backend/entry/provider route 集合为空。
- ADR-0061 已接受；D-04 以空支持集关闭。Task 1B.1 只解锁内部 fail-closed schema 实施，不
  产生 production artifact 或 platform qualification。

## 原生证据

[Platform Capability Probe run 30579701659](https://github.com/ferqx/kite-code/actions/runs/30579701659)
绑定 `a4bdf22aa7c2a987734524c278c4750e7b9faa96`，三平台 job 与 JSON artifact 均成功且
`outcome=excluded`、`productionSupported=false`：

- `platform-capability-macos-15`：
  `sha256:048aeac4d4041926cc23961410ab7b1c9008cbe721cdc13c7820ff24dc3f06d9`
- `platform-capability-ubuntu-24.04`：
  `sha256:0f6e329339621a32ae2b71c6288da7066099e64ec3e76b9128fd50e0e79dfc2a`
- `platform-capability-windows-2025`：
  `sha256:7102fbfabc04cdbf74d53c99b67ef3cc4c8975b7d81f379bc750f2568bd04a99`

独立只读复核未发现 1B.0 的 P0/P1，并确认空支持集是 bounded spike 的有效保守完成结论。

## 限制与回滚

- 当前没有任何 production-supported platform，不能生成 production artifact。
- 未来非空支持项必须新增 ADR、产生匹配 backend/profile/composition/runner identity 的新鲜
  原生证据，并由独立 release gate 追加；不能改写本完成记录。
- 回滚只能进一步排除候选或关闭 capability，不能恢复裸 shell、代理环境变量 allowlist 或
  backend discovery 即准入。
