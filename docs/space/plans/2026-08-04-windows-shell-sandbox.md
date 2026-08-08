# Windows Shell 沙箱实施计划

状态：superseded（ADR-0088 移除 AppContainer backend；保留本文作为实施历史）
创建：2026-08-04
最后更新：2026-08-07
优先级：P1
依赖：ADR-0061、ADR-0065、ADR-0072、ADR-0073、ADR-0074、ADR-0077、ADR-0078、ADR-0079、ADR-0080、ADR-0081、D-04（空支持集）
设计依据：`docs/active/windows-shell-sandbox.md`

## 目标

本计划现在维护两条明确分离的 Windows Shell 路径：

1. ADR-0081 的 windows_restricted_token 是默认 development backend。它使用无 UAC 的
   current-user WRITE_RESTRICTED token、capability-SID ACL、native Job 和真实 canonical Workspace；
   正常路径不创建整个仓库的 private staging 副本。每个 Workspace 的 capability SID 与 static
   protected-path DACL snapshot 由可修复 ledger 管理。
2. windows_appcontainer 是 KITE_WINDOWS_APPCONTAINER_EXPERIMENTAL=1 才会选择的迁移/实验
   候选。它继续使用 Classic AppContainer、private staging、Worker 预算、回写与 ACL journal，
   但不再是大仓库的默认执行路径。

两条路径均保持 excluded/productionSupported=false。direct backend 没有 structural network、
dynamic root .env.* 或 Full qualification；AppContainer staging admission 也不构成 production
qualification。仅在用户脚本前确认 sandbox environment 或必要 startup capability unavailable 时，
允许开发 App 选择宿主 Bash/cmd/PowerShell；effective backend=none、Full 不可用，且不重放脚本。

## 非目标

- 不改变 D-04 空支持集；productionSupported 恒为 false，outcome 恒为 excluded；
- 不更新 approved qualification registry；
- 不把 direct restricted-token 的 static ACL 当成 future .env.* 的动态保护；
- 不把 direct restricted-token 当成 arbitrary descendant 的 network-off/allowlist boundary；
- 不在正常 TUI 启动或普通 Shell 请求中要求 UAC、创建 local account、写 WFP 或执行 elevated setup；
- 不开放 Full、Skill child 与 local stdio MCP；
- 不使用 GitHub-hosted Windows Server 冒充 Win10/Win11 客户端证据；
- 不将 AppContainer Worker、预算、timeout 或 staging admission 拒绝改为 host Shell。

## 安全不变量

1. 默认 Windows development path 是无 UAC 的 windows_restricted_token，Shell cwd 直接是 canonical
   真实 Workspace，禁止 whole-repository staging/copy；
2. direct token 在用户脚本前的 runner pin、OS baseline 或 structural token/Job startup unavailable
   才可由允许 fallback 的开发入口选择 host Bash/cmd/PowerShell；effective backend=none、Full 不可用；
3. 用户脚本一旦交给 native backend，non-zero exit、timeout、cancel、runner/Job/ACL cleanup failure
   均保持该 backend 的 fail-closed result，绝不 host replay；
4. direct token 的 persistent Workspace capability SID 必须有 canonical-path ledger、static protected
   DACL snapshot 和 explicit repair/uninstall；恢复失败不得伪造新 ACL 或声称动态保护；
5. direct token 不得声称 structural network-off、allowlist、Workspace 外 read deny 或 future root .env.*
   deny；因此 Full 与 production qualification 不可用；
6. AppContainer 仅为显式实验：其 Worker、budget、timeout、protocol、staging admission、reconciliation
   和 cleanup failure 一律拒绝，不能选择 host Shell；
7. 首版固定 networkMode=off 的 production boundary；direct backend 不满足该 production enforcement；
8. 不继承 API key、MCP token、SSH agent、代理凭据和危险 runtime 变量；
9. Job 负责 child/grandchild 生命周期、hard process limit 与 timeout/cancel cleanup；它不单独证明
   filesystem 或 network isolation；
10. 命令字符串检查只能是附加防御，不作为 filesystem enforcement；
11. Win11 是主要 native E2E；Win10 22H2 (10.0.19045) 只作为 API/build baseline；
12. Full 选择必须根据 Full-qualified capability，而非仅 backend 非 none；windows_restricted_token
    与 host none 的 UI 文案为 非沙箱环境无法开启full。

## 实施步骤

| Task | dependsOn | 文件/产出 | 定向验证 | 迁移与回滚 | 状态 |
| --- | --- | --- | --- | --- | --- |
| W1 文档 | — | `docs/active/windows-shell-sandbox.md`、`docs/adr/0072-*.md`、本计划 | `bun run check:docs` | 文档先行，编码前收敛 | ✅ |
| W2 协议与 backend 类型 | W1 | `src/core/sandbox/platform.ts`（backend 枚举）、`src/core/sandbox/types.ts`、`src/core/config/execution-qualification.ts`（zod 枚举）、`scripts/release/platform-capability-probe.ts`（zod 枚举）、`tests/sandbox/platform-backends.test.ts` | `bun test tests/sandbox/platform-backends.test.ts tests/sandbox/execution-boundary.test.ts tests/sandbox/platform-capability-probe.test.ts`；`bun run typecheck` | 新枚举值向后兼容；旧 artifact 解析不受影响 | ✅ |
| W3 Rust runner | W2 | `native/windows-appcontainer-runner/Cargo.toml`、`src/main.rs`、`src/protocol.rs`、`src/appcontainer.rs`、`src/acl.rs`、`src/lib.rs` | cargo build（GNU target）；`cargo test`（协议/ACL/quoting 纯逻辑） | 不可用时不选该 backend；`excluded` 保持 | ✅ 编译通过、11 个 Rust 测试通过；Win11 本机原生验证 |
| W4 Bun adapter | W2、W3 | `src/core/sandbox/appcontainer.ts`（runner 定位/digest 校验/协议解码）、`src/core/sandbox/windows-runner.ts`（release 清单）、`src/core/sandbox/executor.ts`（`windows_appcontainer` 分支）、`src/core/sandbox/process-tree-capability.ts`（`windows_job_active_process_limit` 投影） | `bun test tests/sandbox/windows-appcontainer.test.ts tests/sandbox/process-tree-limit.test.ts`；`bun run typecheck` | raw runner 缺失/损坏与 staging admission → 拒绝；仅独立结构性 probe 证明 sandbox 环境不可用时可交给统一 fallback resolver | ✅ |
| W5 清单与 evidence | W3 | `release/platform-capabilities/windows-runner-v1.json`、`scripts/release/windows-runner-evidence.ts`（构建产物 digest）、`scripts/release/platform-capability-probe.ts`（Windows 原生分支）、`.github/workflows/platform-capability-probe.yml`（Windows 构建步骤） | `bun run scripts/release/platform-capability-probe.ts`（Win11 本机）；`bun run scripts/release/verify-platform-capability-evidence.ts` | digest 来自实际构建产物，不手写 | ✅ 清单含真实构建产物 digest；Win11 probe 输出 `windows_appcontainer`/`excluded`/`productionSupported=false` |
| W6 测试 | W3、W4 | `tests/sandbox/windows-appcontainer.test.ts`、`tests/sandbox/platform-backends.test.ts`（补 backend selection）、`tests/sandbox/platform-capability-probe.test.ts`（补 Windows 分支 verdict）、`tests/sandbox/process-tree-limit.test.ts`（补 Job 投影） | `bun test tests/sandbox/windows-appcontainer.test.ts tests/sandbox/platform-backends.test.ts tests/sandbox/platform-capability-probe.test.ts tests/sandbox/process-tree-limit.test.ts` | 原生测试只在 win32 + 非 elevated + runner 存在时运行 | ✅ |
| W7 文档同步 | W4、W5 | `docs/active/execution-platform-support.md`、`docs/active/execution-boundary.md`、`docs/active/shell-platform-compatibility.md`、`docs/documentation-map.json`、`docs/space/plans/index.md` | `bun run check:docs-impact`、`bun run check:docs`、`bun run check:core-boundary` | 行为变化必须同步 active 文档 | ✅ |
| W8 验证 | W2–W7 | 全量回归 | `bun run test:all`、`bun run typecheck`、`bun run check:core-boundary`、`bun run check:docs` | 任一失败：修复或回退该 Task | ✅ typecheck/check 全绿；默认套件与 baseline 比较无净新增失败（本机既有环境失败：symlink EPERM、TUI 时序、shell-exec Windows job-guard） |
| W9 staging 资格预算与 fail-closed admission | W4、W7 | `workspace-staging*.ts`、`appcontainer.ts`、`src/app/sandbox/composition.ts`、相关测试与 active 文档 | `bun test tests/sandbox/windows-appcontainer.test.ts tests/sandbox/app-sandbox-composition.test.ts`；`bun run typecheck` | 超限/Worker/超时拒绝；仅独立 `:` probe 的真实 sandbox 环境不可用可在用户脚本前走 resolver；命令期重查 fail closed、无重放 | ✅ 定向测试通过；Worker 预算测试在全量套件高负载下偶发时序 flake，单独运行稳定通过 |
| W10 无 UAC 本地 direct restricted-token 与受管 Online 联网路径 | W2、W3、W7 | restricted_token.rs、direct_workspace.rs、managed identity/launcher、protocol V4、direct adapter/composition、Full capability gate、逐调用 development 网络授权、相关测试与 active 文档 | bun test tests/tool-definitions.test.ts tests/tool-runner.test.ts tests/sandbox/platform-backends.test.ts tests/sandbox/app-sandbox-composition.test.ts tests/sandbox/windows-appcontainer.test.ts tests/sandbox/windows-restricted-token.test.ts；cargo test；bun run typecheck；Win11 native E2E | startup structural unavailable 才允许用户脚本前 host fallback；命令失败、ACL cleanup 与 AppContainer admission 不重放；`allow_all` 不提升 production network 资格 | ✅ 定向测试与 Win11 非 elevated native E2E（11/11）通过，cargo test 36 通过；受管 Online 联网 E2E 仍为显式提权 opt-in（`KITE_RUN_WINDOWS_MANAGED_NETWORK_E2E=1`，需先完成 setup） |
| W11 TUI 启动期静默预热（ADR-0087） | W10 | `src/app/sandbox/composition.ts`（abortable prepare + preflight 清扫）、`src/app/tui/index.tsx`（trust/config 后静默触发）、`src/app/tui/exit-coordinator.ts`、`src/app/tui/components/first-run/WindowsSandboxSetupGate.tsx`（确认时点 re-check）、`src/core/sandbox/windows-network-setup.ts`（entry predicate）、相关测试 | bun test tests/sandbox/app-sandbox-composition.test.ts tests/sandbox/windows-network-setup.test.ts tests/tui-exit-coordinator.test.ts；bun run typecheck | 预热静默、退出中止不留 ACL/runtime 残留、并发实例互不干扰；一次性 OS 扫描成本不落在首条命令计时窗口 | ✅ 定向测试通过；AV 一次性成本本身不可由代码消除，预热仅转移其支付时点 |

## 实施偏差记录

- ADR-0081 扩展本计划：windows_restricted_token 成为无 UAC 的默认 development backend，直接使用
  真实 Workspace 与 persistent capability-SID ACL ledger；它不替代 AppContainer 的实验 staging，也不
  获得 Full、dynamic protected-glob、structural network 或 production qualification。
- ADR-0082 将 direct invocation protocol 升为 V3；adapter/runner 要拒绝 V1/V2，避免旧 runner 忽略
  sandboxMode/networkMode。windows-runner-v1.json 仍是 manifest schema/file naming V1，manifest
  protocolVersion 固定为 4。V4 的 `allow_all` 只对齐 development approval，并切换受管 Online 登录会话；不产生 structural network
  evidence。


- 原生 runner 结构从计划中的 `job.rs`/`launch.rs`/`env.rs`/`cleanup.rs` 合并为
  `appcontainer.rs`（Job/launch/terminate）+ `acl.rs`（ACL 授予/回收）+ `main.rs`（编排）。
- 取消通道使用 stdin cancel 帧 + stdin EOF 双重信号（EOF 覆盖 adapter 崩溃 → 无残留）。
- 环境变量 allowlist 由 TS adapter 构建并随请求下发；必须包含 essential Windows 系统变量
  （`SystemRoot`、`USERPROFILE`、`APPDATA` 等），否则 AppContainer 的 `CreateProcessW` 以
  `ERROR_ENVVAR_NOT_FOUND` 拒绝；创建标志必须含 `CREATE_UNICODE_ENVIRONMENT`（否则 env block
  按 ANSI 解释，`ERROR_INVALID_PARAMETER`）。
- 命令字符串由 TS adapter 发送原始命令，runner 用 `CommandLineToArgvW` 引号规则构建
  `bash --noprofile --norc -c <command>`。
- 协议：stdin 单请求帧 + stdout 多帧（stdout/stderr/exit）+ 4 字节 LE 长度前缀。
- **关键发现（Win11 本机原生验证）**：Classic AppContainer + Job Object 边界真实生效
  （`cmd.exe` 在 AppContainer 内 exit 0，进程创建/等待/Job 清理确认全部通过），但 vendored
  MSYS2 runtime（`msys-2.0.dll`）在 AppContainer 内无法初始化：所有 MSYS2 二进制（bash、
  printf 等）以 `STATUS_DLL_INIT_FAILED`（0xC0000142）退出。因此 Shell 执行在 AppContainer
  内不可用，probe 如实输出 `excluded`、`productionSupported=false`。后续候选方向：评估
  BusyBox-w32 等非 Cygwin 运行时，或接受该限制保持 fail closed。
- W9 将昂贵的真实 Workspace copy/hash 前移为 Worker 资格预算；超限、Worker 或超时均是
  fail-closed admission denial，不能选择 host fallback。仅独立 `:` probe 确认真实 sandbox 环境或
  必要 capability 不可用时，才由统一 resolver 在用户脚本前处理；实际 staging 仍重查预算并保持 fail closed。
- W10 收尾修复两处确定性缺陷：`platformCapabilityEvidenceV1Schema.backend` 补齐
  `windows_restricted_token`（W2 只加了 `windows_appcontainer`，导致 Win11 probe 输出被
  `verifyPlatformCapabilityEvidenceV1` 拒绝；production qualification registry 的枚举保持不变，
  仍有意排除该 development backend）；`app-sandbox-composition` 的 allowlist 边界测试改为断言
  POSIX 127 退出码与命令名，不再匹配英文 locale 的 `command not found` 文案（vendored isksh
  输出本地化诊断）。

## 完成条件

- windows_restricted_token 在 Win11 本机、非 elevated 情况下可用受限 current-user token、capability
  SID、suspended token verification 与 Job 直接执行真实 Workspace；不复制整个仓库；
- direct backend 的 Full 禁用、startup-only host fallback、no replay、ledger repair 以及 strict
  network/dynamic-glob/production negative projection 在定向测试和 active 文档中收敛；
- persistent capability ledger V2 以 digest/readiness marker 提供 steady-state 无锁快路径；V1/中断 setup
  在 30 秒有界 per-Workspace mutex 内迁移或恢复，并发短命令不得再触发 2 秒 ledger lock timeout；
- backend `windows_appcontainer` 可在 Win11 本机（非 elevated）创建 AppContainer + Job Object
  并执行原生进程（`cmd.exe` exit 0），返回结构化 receipt；
- probe 的 Windows 分支输出真实 native conformance verdict（`windows_appcontainer` backend、
  `excluded`），不再由 `backend=none` 全 `unavailable` 短路；
- `productionSupported=false`、`outcome=excluded` 保持；approved registry 未改动；
- W9 的 Worker 预算/准入拒绝、命令期预算重查、仅 sandbox 环境不可用时的用户脚本前 fallback 与 Full 禁用在定向测试中收敛；AppContainer 只在显式实验开关下选择。
- 相关 active 文档与实现收敛；`check:docs-impact`、`check:docs`、`check:core-boundary`、
  typecheck 通过；默认测试无新增失败（本机 3 项 symlink EPERM 与 2 项 shell-exec desc 终止、
  1 项 TUI 时序失败均为基线既有环境问题，已在 baseline worktree 复现）。


## 已知限制（完成后保持 fail closed）

- vendored MSYS2 runtime 仍无法在 Classic AppContainer 内初始化（`STATUS_DLL_INIT_FAILED`）；当前
  实验路径使用已验证的静态 `isksh` + Coreutils，BusyBox-w32 不进入 runtime/manifest；
- private staging 仅适合未超过 4,096 个 eligible regular file / 64 MiB 的实验 Workspace；超限是
  fail-closed admission denial，不是用户脚本前 host fallback，也不是 production 隔离；
- direct restricted-token 已作为 development backend 直接操作真实 Workspace，但它没有 WFP/structural
  network-off、future .env.* COW/projection 或 Full/production qualification；static protected ACL 与
  ledger repair 不能扩大为这些保证；
- 用户 profile 默认只读残余面未测量；Win10 仅是 ADR-0074 API/build baseline；GitHub-hosted Windows
  Server 不能代替客户端证据，approved qualification registry 保持空集。

## 回滚

- native direct runner 缺失、digest 不匹配、低于 Windows API baseline 或 initial token/Job structural
  startup unavailable 时，允许 fallback 的开发 App 只可在用户脚本前选择 host Shell；effective backend
  为 none、Full 禁用、绝不重放脚本。production/raw entrypoint 继续 fail closed；
- 关闭 KITE_WINDOWS_APPCONTAINER_EXPERIMENTAL 或移除实验 runner 只使 AppContainer 候选不可用；
  它不能把 Worker、预算或 staging admission 拒绝改为 host Shell；
- 可以缩小 direct Workspace scope、收紧 Job process limit、执行 explicit ledger repair/uninstall，
  或删除候选 backend；
- 不能把 direct static ACL 误报为动态 protected glob/network isolation，不能以审批恢复 Full，
  也不能把 implementation complete 当作 production qualification。
