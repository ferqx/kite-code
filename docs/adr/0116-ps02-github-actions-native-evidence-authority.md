# ADR-0116：PS-02 的原生平台证据由 GitHub Actions 矩阵提供

状态：accepted

日期：2026-08-18

决策者：用户直接指令

相关：ADR-0061、ADR-0065、ADR-0111、`docs/space/plans/2026-08-16-trustworthy-runtime-convergence.md`

## 背景

PS-02 的实现验收关注 `SandboxExecutionProviderV1`、Tool Pipeline 接线、allocating
preparation/dispatch/disposal 的 durable lifecycle、consumer-owned spawn、恢复与 fail-closed
边界。该验收不应把当前开发机的操作系统误当作所有发行目标的平台证据，也不应为了在非目标操作系统
继续推进而使用 fake、依赖注入、容器、WSL 或指令模拟伪造原生隔离。

既有 ADR-0061 与 ADR-0065 已规定平台能力使用固定 GitHub-hosted 原生 OS 矩阵，但此前 PS-02
状态文字仍把本机无法运行 Linux 原生路径描述为任务阻塞。需要把“实现验收”和“平台能力准入证据”
明确分层，同时保留当前空 production support set 与各 backend 的 fail-closed 结论。

## 决策

1. PS-02 的原生平台资格证据权威是 `.github/workflows/platform-capability-probe.yml` 的
   GitHub-hosted 原生矩阵：`macos-15`、`ubuntu-24.04`、`windows-2025`。本地非目标 OS、
   Docker、WSL、交叉编译、emulation、fake 或 DI 测试都不是该证据的替代物。
2. 每个矩阵 job 必须在生成证据前成功执行仓库声明的 required native conformance、probe 和
   独立 verifier；verifier 必须以 workflow 的可信来源字段重建 source identity、canonical
   payload digest、限制与 outcome，并固定 `productionSupported=false`。缺步骤失败、verifier
   失败、artifact 缺失或 source/digest 不匹配都使该 job 失败。
3. 通过 `actions/upload-artifact` 上传的 evidence 与 verification JSON 是不可变的 CI artifact，
   以 exact OS/architecture、repository/head/ref/workflow/run/attempt 和封闭 runner class 绑定。
   workflow 的存在、配置静态检查、候选 diagnostic 输出或本地测试通过本身都不能被写成某次
   GitHub Actions run 已通过；没有绑定当前 head 的成功 run 时，状态记录为 `waiting_ci`。
4. Linux cgroup descendant cleanup 与 full-chain diagnostic 保持显式 opt-in、candidate-only、
   与 platform capability evidence 分离。它们可以帮助后续 backend 设计，但运行、缺失或失败都
   不能冒充 required native evidence，也不能改变 PS-02 的 production support 结论。
5. 本 ADR 只规定 PS-02 的证据来源与状态表达，不批准任何新的 backend 或 capability。当前
   `release/platform-capabilities/support-matrix-v1.json` 的空支持集、`productionSupported=false`、
   Darwin/Windows/Linux 的既有 fail-closed 缺口保持不变。任何非空 production support set 仍需
   新鲜原生 evidence、新 ADR 与独立 release gate，不能由 workflow 成功自动提升。

## 后果

PS-02 的跨平台实现可以在当前工作树完成其 protocol、lifecycle、recovery、no-bypass 与定向
conformance 验收；是否具备某个平台的原生 execution capability 由绑定当前 head 的 Required
GitHub Actions run 决定。本机不支持目标 backend 不再是实现任务本身的 blocker，但未运行的 CI
仍必须如实记录为 `waiting_ci`，不能预填 passed 或 supported。

平台证据和 production admission 继续正交：即使三平台 workflow 生成了 verified candidate
artifact，也不会自动写入 support matrix、打开 Shell/Skill/local stdio MCP 或允许裸 host fallback。

## 回滚

可以收紧矩阵、增加 required conformance 或把平台状态从 `supported` 改回 `excluded`/`waiting_ci`。
不能回滚为本地非目标 OS、容器、fake/DI、emulation 或 workflow 配置存在替代成功原生 run，也不能
回滚为把候选 diagnostic 或 `productionSupported=false` artifact 当作 production approval。
