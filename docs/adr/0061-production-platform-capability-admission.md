# ADR-0061：生产平台能力必须由原生探针逐项准入

状态：accepted
日期：2026-07-31
决策者：`github:@ferqx`（Platform + Security，single-maintainer）
关联：D-04、Phase 1B、ADR-0053、ADR-0054

## 背景

现有 macOS Seatbelt 与 Linux bubblewrap 后端只表示可以启动某种 sandbox，不表示
Workspace 外写、受保护路径、symlink escape、network allowlist、完整 process tree 或所有
production 入口都已被技术边界约束。Windows 当前没有对应后端。本项目也没有通过 conformance
的无进程只读 fallback。

把 backend discovery、顶层 shell 并发许可、自然退出的 child 或代理环境变量当作 enforcement，
会错误地扩大 D-04 的生产支持集合。

## 决策

1. 平台证据使用 `PlatformCapabilityEvidenceV1`。每份证据绑定实际 OS release/version、
   architecture、Bun 版本、backend、TUI/foreground CLI 入口、filesystem、network、
   process-tree 与 shell/Skill/local stdio MCP inheritance，并附 canonical JSON SHA-256。
   `selectedNetworkMode` 明确绑定本次准入使用 `off | allowlist`；未选择的能力可以保留
   `unsupported`，但不能被对应 profile 使用。
2. 平台结论只允许：
   - `supported`：所有进程型 filesystem、network-off、process-tree/inheritance 和两个入口
     均为 `enforced`；allowlist 可为 `unsupported`，此时平台只支持 network-off profile；
   - `read_only_only`：两个入口均已证明安装同一边界，且独立的无进程只读 conformance 与
     network-off 均为 `enforced`；
   - `excluded`：任何必需能力缺失、不可验证或不支持。
3. 完整 process tree 的硬数量上限和 kill 后无残留只能是 `enforced | unsupported`。顶层
   invocation permit、PID namespace、`--die-with-parent` 或 child 自然退出都不能产生
   `enforced`。
4. 当前候选方向固定为 macOS Seatbelt、Linux bubblewrap/network namespace；Windows 在有
   原生 backend 前保持 `excluded`。这不是对候选后端的生产批准。
5. 当前 production-supported platform 集合为空。macOS 15、Ubuntu 24.04 与 Windows Server
   2025 原生探针均已固定为 `excluded`、`productionSupported=false`：
   - macOS Seatbelt 与 Linux bubblewrap 候选仍缺 Workspace 外/protected path 的完整 deny、
     process-tree 硬上限、完整继承和 TUI/CLI 入口组合证据；
   - Windows 没有 filesystem/network sandbox backend；
   - 三个平台都没有 verified in-process read-only fallback。
6. `.github/workflows/platform-capability-probe.yml` 必须在声明支持的 runner 上生成原生 evidence
   artifact。probe 只输出技术 `outcome`，其 `productionSupported` 必须恒为 `false`；只有证据
   已固定、矩阵字段全部满足且 ADR 已接受后，独立 release gate 才能把对应组合加入
   production support set。`backend=none` 不得输出进程型 `supported`。
7. 三平台 artifact 已固定，本 ADR 接受“空支持集”结论并据此关闭 D-04、完成 Task 1B.0。
   Task 1B.1 可以开始冻结 fail-closed schema；这不产生 platform qualification。任何非空支持
   集必须由后续 ADR、匹配的新鲜原生证据和独立 release gate 追加，不能改写本次空集结论。

## 备选方案

- backend 存在即视为支持：拒绝，不能证明具体能力或入口继承。
- 审批后回退裸 shell：拒绝，审批不能创造技术隔离。
- 用 HTTP(S) proxy 环境变量实现 allowlist：拒绝，child 可以绕过。
- 把无进程只读 fallback 推断为可用：拒绝，必须有独立 conformance。

## 后果

当前发布支持矩阵保持空集合，D-04 以空集关闭，1B.1 仅解锁内部 schema 实施，不解锁
production artifact。探针会保守地暴露缺口；新 backend、runner 或 composition root 必须重新
产生完整证据并通过新的追加决策。

## 回滚

可以进一步排除平台、关闭 network/writer/process capability，或删除未采用的候选后端。不能
回滚为 backend discovery 即准入、把未运行探针标为已验证、用顶层并发计数冒充 process-tree
硬上限，或在 D-04 开放时生成 production artifact。
