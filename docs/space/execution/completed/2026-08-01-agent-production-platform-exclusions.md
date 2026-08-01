# Agent 生产化 Phase 1B Task 1B.2/1B.3 完成记录

状态：completed
日期：2026-08-01
计划：
[`2026-07-29-agent-production-execution-isolation.md`](../../plans/2026-07-29-agent-production-execution-isolation.md)
执行者：`github:@ferqx`
实现提交：`c9e0dccdaad4cc6a6db57b54d80e0074e3bf8aa4`

## Gate 决策

结论：`approved_to_complete_1B.2_1B.3_as_excluded_and_activate_1B.5`。

这是负向完成：最新候选实现与三平台原生 artifact 已能稳定、可解释地拒绝不满足生产隔离
定义的组合。macOS、Ubuntu 与 Windows 均保持 `excluded`、`productionSupported=false`；
D-04 的 `accepted_empty_support_set`、批准 qualification registry 与 support matrix 不变。
本结论不生成 production artifact、不加入任何平台、backend、Shell 或 writer 支持项，且
不产生 `MS:1B-DONE`。它只解除 Task 1B.5 对 1B.2/1B.3 的依赖。

## 实际 commit / artifact

- `c9e0dccdaad4cc6a6db57b54d80e0074e3bf8aa4`：分离 backend discovery 与真实 namespace
  usability，增加 bubblewrap syscall-filter strength、具名 process-tree hard-count mechanism、
  admission fail-closed 与跨平台专项测试；同时修正 fault-soak 对 TUI lifecycle harness 的发现和
  outer process-group ownership/identity-safe cleanup；
- [Platform Capability Probe run 30693651821](https://github.com/ferqx/kite-code/actions/runs/30693651821)
  绑定同一提交，三个 native job 全部通过并分别上传 raw candidate evidence；
- macOS 15 artifact `platform-capability-macos-15`，artifact id `8816525761`，evidence digest
  `sha256:439b29a506a43d8ff684a289a0ee083fffff2ac08849798a2082299f78029590`；
- Ubuntu 24.04 artifact `platform-capability-ubuntu-24.04`，artifact id `8816527325`，evidence digest
  `sha256:88e9de9a7480dc27bd651a477d5befd2ca3b3bdb1413b30b8d07cfdf24dcf176`；
- Windows Server 2025 artifact `platform-capability-windows-2025`，artifact id `8816532433`，evidence
  digest `sha256:7dfd1390fae758ac64d74476231e53dd4f5233bef6a5e8832fc324dcb6a82f7d`。

这些 raw candidate artifact 是完成证据，不是 release-pinned qualification。固定 D-04 证据仍为
run `30579701659` 与 `release/platform-capabilities/support-matrix-v1.json` 中的空支持集。

## Task 1B.2 结论：macOS

- macOS 15.7.7 arm64 选择 Seatbelt；Workspace read/write/read-only、Workspace 外 deny、protected
  path deny、symlink escape deny、network-off 与 shell descendant/grandchild 均为 `enforced`；
- Seatbelt 使用独立 policy 机制，`backendIsolation.syscallFilter=unsupported` 不单独否定它；
- `hardCountMechanism=none`、硬 process-tree count 与 kill 后无残留确认均为 `unsupported`，
  forked Skill 为 `unavailable`、local stdio MCP 为 `unsupported`、TUI/foreground CLI composition
  为 `unavailable`；
- 因此 macOS production process/write surface 保持关闭。开发期 profile 加固不能冒充
  production qualification。

## Task 1B.3 结论：Linux/Windows

- Ubuntu 24.04 runner 虽安装 bubblewrap，但真实 PID/network namespace 最小探针不可用，故
  backend 必须投影为 `none`；workflow 绿色只证明排除逻辑与 artifact 生产正常，不证明
  bubblewrap 可执行边界；
- Ubuntu 的 syscall filter 为 `unavailable`、`hardCountMechanism=none`，filesystem、network-off、
  descendants、Skill/MCP 与两个入口均没有 production evidence，因此稳定 `excluded`；
- Windows Server 2025 没有接受的 sandbox backend，`backend=none`、
  `hardCountMechanism=none`，所有进程型能力保持关闭并稳定 `excluded`；
- 两个平台都没有另行通过无进程 `verified_in_process_read_only` conformance，不能降级为
  `read_only_only`。

## 验证命令与结果

- `bun run check:docs-impact`：passed；
- `bun run check:docs`：10 plans、108 tasks、14 decisions passed；
- `bun run check:core-boundary`：passed；
- `bun run typecheck`：passed；
- `bun run format:check`：exit 0，只有 194 个既有 warning 与 16 个 info；
- `bun run test`（宿主环境）：2357 pass、6 skip、0 fail；另 5 个 process-isolated 文件全部通过；
- `bun run test:runtime:soak`（宿主环境）：7/7 case passed，failure codes 为空，orphan PID、orphan
  worktree 与 residual path 均为 0；report digest
  `sha256:9e7e19ac31396282556b13a4cbe839318d117bfb32a06476bdc6cf37c925f7d0`；
- Platform Capability Probe run `30693651821`：macOS/Ubuntu/Windows 三个 native job 全部通过；
- [Required run 30693651834](https://github.com/ferqx/kite-code/actions/runs/30693651834)：quality、
  unit、compaction-contract、runtime-e2e、runtime-fault-soak 与完整 tui-system 六个 job 全部通过；
- 两路独立复核最终均为 GO，P0/P1/P2 各为 0。

## 未运行项

- 没有运行或生成 `release:smoke`、approved execution qualification、Release Manifest 或
  production artifact；这些属于 Task 1B.9/2A，且当前空支持集不允许提前生成；
- 没有把本地 CI profile 当作 1C.7 release qualification；TUI 资源资格仍等待 Ubuntu 手动
  qualification 的 8 轮 artifact；
- 没有实现 cgroup pids、Windows Job active-process limit 或已接受等价 hard-count backend，
  因而对应平台按计划关闭 production Shell，而不是把未运行项写成通过。

## 风险、限制与 rollback

- 三平台结论都是排除，不代表候选 backend 已达到 production 隔离强度；
- Ubuntu hosted runner 的 namespace 限制可能与其他 Linux 环境不同。未来只能用新的 exact
  environment evidence 和追加治理 revision 重新评估，不能复用本次绿色 workflow；
- rollback 只能进一步关闭候选 backend/process surface；不得恢复 binary-only discovery、
  裸 shell fallback、未具名 hard-count verdict 或从旧 artifact 缺失字段推断 `enforced`；
- TUI fault-soak 的 CI profile 只验证功能、终态、状态不变量与清理，不提供正式资源斜率资格。

## 与计划偏差

- Task 1B.2 原目标包含 macOS hard process-tree limit；目标平台没有可证明机制，因此按计划中的
  失败关闭条款以 `excluded` 负向完成，而不是降低定义；
- Task 1B.3 原计划候选为 bubblewrap/Windows backend。Ubuntu runner 的真实 namespace probe
  失败后改为 `backend=none`，Windows 也保持 `none`；这符合“unsupported 不伪装 sandbox”的
  既定 rollback；
- 复核同时发现 fault-soak 曾把 lifecycle harness 从普通 scenario 发现中移除却未显式追加，
  导致 TUI case 能以零状态不变量通过。本批增加专用参数并统一 outer process group，属于证据
  可信度修复，不扩大 production capability。

## Active 文档与 ADR 收敛

- 当前行为已同步到 `docs/active/execution-boundary.md`、
  `docs/active/execution-platform-support.md`、`docs/active/runtime-resilience-qualification.md`、
  `docs/active/tui-e2e-standards.md`、book 第 5/12 章与 `docs/documentation-map.json`；
- 没有新增架构决策；本次实现遵循 accepted ADR-0054 与 ADR-0061，未改写 accepted ADR 历史；
- Task 1B.5 以实现提交 `c9e0dccdaad4cc6a6db57b54d80e0074e3bf8aa4` 为 binding 基线进入
  shared protected-path policy 实施。它不得借本记录重开任何已排除平台。
