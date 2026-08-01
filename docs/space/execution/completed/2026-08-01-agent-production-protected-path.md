# Agent 生产化 Phase 1B Task 1B.5 完成记录

状态：completed
日期：2026-08-01
计划：
[`2026-07-29-agent-production-execution-isolation.md`](../../plans/2026-07-29-agent-production-execution-isolation.md)
执行者：`github:@ferqx`
激活基线：`c9e0dccdaad4cc6a6db57b54d80e0074e3bf8aa4`
实现提交：`138fee19d7ce9f9622f1e32ea1d7cfdd2076bf8c`、
`512e2c3582bdd2bea2e7f670213f7616f545084c`
资格证据提交：`e6e0ffb51115c3380a1dcc340dd1627b3bdd0970`

## Gate 决策

结论：`approved_to_complete_1B.5`。

该结论只确认 shared protected-path policy、Registry/Harness gate、native sandbox projection、
Sub-agent 继承和关闭状态下的 local stdio MCP admission 已完成。它不完成 Phase 1B，不产生
`MS:1B-DONE`，不改变 D-04 的 `accepted_empty_support_set`，也不允许任何 Shell、Skill、writer
或 MCP transport 进入 production support set。

## 实际 commit / artifact

- `138fee19d7ce9f9622f1e32ea1d7cfdd2076bf8c`：新增 protected-path V1 evaluator、声明式
  Registry path access、Harness pre-dispatch/TOCTOU recheck、search pruning、MCP cwd admission
  和当前行为文档；
- `512e2c3582bdd2bea2e7f670213f7616f545084c`：补齐 conservative ASCII case alias、Seatbelt
  shared-rule projection、生产缺 gate fail-closed、Sub-agent 真实继承链和 closed exception ratchet；
- `77db1830771aaf65116fb8802892d74c4bcbd7dc`：修正 Seatbelt regex literal 转义，并把 native
  mixed-case protected-path probe 纳入平台 workflow；
- `e6e0ffb51115c3380a1dcc340dd1627b3bdd0970`：最终独立复核与 CI 资格 head；
- [Required run 30705493952](https://github.com/ferqx/kite-code/actions/runs/30705493952)：绑定
  `e6e0ffb51115c3380a1dcc340dd1627b3bdd0970`，quality、unit、compaction-contract、runtime-e2e、
  runtime-fault-soak 与 tui-system 六个 job 全部通过；TUI runner 通过 38 个隔离 PTY scenario；
- [Platform Capability Probe run 30705493919](https://github.com/ferqx/kite-code/actions/runs/30705493919)：
  macOS 15、Ubuntu 24.04、Windows 2025 三个 native job 全部通过；
- macOS artifact `platform-capability-macos-15`，artifact id `8820200695`，raw evidence digest
  `sha256:6bc8332393bd10da97170cc4d314d66e21e0f005b751da16cd9a649361ee2559`，zip digest
  `sha256:48a304768ae04b501c8609f3ee3f7e5b1de7ad9cbd7c71a4fe733c654d2bcde3`。artifact 仍明确
  `outcome=excluded`、`productionSupported=false`。

## 结论

- evaluator 同时保留 canonical path 与 lexical protected identity，按 `read | write | execute`
  求值；deny 优先于 allow，并拒绝 Workspace 外路径、`.git`、Agent/MCP 配置、credential 与
  shell profile；
- 大小写处理只对内建 protected identity 做 conservative ASCII alias，不把整个 canonical path
  全局 lower-case，避免在 case-sensitive volume 上扩大 allowlist；
- 所有 filesystem builtin 从 Registry spec 声明 path/operation，在 execute 前统一求值；新增
  filesystem builtin 若没有 hook 或不在闭合 exception 集，ratchet 测试直接失败；
- Harness 在 write pre-image 前求值，并在异步 pre-dispatch hook 后再次检查，避免 TOCTOU；
  production writer 缺 evaluator 时在任何文件 I/O 前 fail closed；
- Workspace-wide search 剪枝 protected descendants；普通 Task child、forked Skill 和 Sub-agent
  继承父级同一 evaluator；
- Seatbelt profile 从同一规则集生成 exact 与 case-alias deny，native macOS probe 已实际拒绝
  `.GIT/config` read 与 `.ENV.TEST` write；`checkDangerousPaths()` 只保留 defense-in-depth；
- local stdio MCP manager 仅在显式注入 evaluator 时允许 canonical admitted cwd，并在 transport
  构造前拒绝 protected cwd。Supervisor/TUI 的完整 boundary wiring、argv/env/runtime pinning
  仍属于 1B.8；当前 sealed production surface 继续关闭 local stdio MCP。

## 验证命令与结果

- `bun test tests/policies/protected-path.test.ts tests/sandbox.test.ts tests/sandbox-executor.test.ts tests/subagent-runner.test.ts tests/mcp-manager.test.ts`：129 pass、0 fail；
- `bun test tests/tool-definitions.test.ts tests/tools.test.ts tests/shell-exec.test.ts`：105 pass、0 fail；
- `bun run test:tui:harness`：99 pass、0 fail；
- `CI=true bun run scripts/run-tui-system-tests.ts long-message input compact-persistence`：3 个隔离
  scenario 文件全部通过；
- `bun run typecheck`、`bun run check:core-boundary`、`bun run check:docs-impact`、
  `bun run check:docs`、Biome 与 `git diff --check`：全部通过；
- Required run `30705493952` 与 Platform Capability Probe run `30705493919` 全部通过；
- 最终独立只读复核结论为 GO，P0/P1/P2 均为 0；另一路计划审计确认实现满足 1B.5 有界范围。

## 未运行项

- 未运行或生成 approved execution qualification、Release Manifest、production artifact 或
  `release:smoke`；这些属于 1B.9/2A，当前空支持集不允许提前生成；
- Ubuntu bwrap 没有等价的 protected-path mask production 资格；Ubuntu 仍是 `excluded`，不能用
  进程内 evaluator 代替 OS boundary；
- 未开放 local stdio/remote HTTP MCP transport。Supervisor/TUI wiring 与 transport revision、
  argv/env/runtime/network enforcement 属于 1B.8；
- 未实现 typed worktree/branch controller、状态展示或全矩阵 conformance；这些分别属于
  1B.6、1B.7 与 1B.9。

## 风险与限制

- App-owned typed Git/worktree controller 尚未实现；模型工具仍不得访问 `.git`；
- case-insensitive alias 仅覆盖共享内建 protected identity。未来增加规则时必须同时进入
  evaluator、native projection 和 ratchet tests；
- local stdio MCP 的 manager-level admission 不等于 transport 已继承完整 filesystem/network/
  process-tree boundary；在 1B.8 完成前 production surface 必须继续关闭；
- 三平台绿色 workflow 证明候选行为与排除逻辑，不是正向 production qualification。

## 与计划偏差

- 计划写有 `src/core/sandbox/shell-wrapper.ts`，实际权威 OS gate 由 shared policy 编译到 Seatbelt
  profile；shell 字符串扫描继续作为次级防线，没有提升为权威 gate；
- bwrap/Windows 没有满足计划强度的 positive backend，按 ADR-0061 与 D-04 保持明确排除，而非
  降低 protected-path 定义；
- MCP 只交付 transport 构造前可复用的 admission contract；完整 lifecycle 集成仍按原依赖留在
  1B.8，没有把 manager 单测冒充生产入口资格。

## Active 文档与 ADR 收敛

- 当前行为已同步到 `docs/active/execution-boundary.md`、
  `docs/active/execution-platform-support.md`、`docs/active/file-reading-shared-boundary.md`、
  `docs/active/mcp-runtime-governance.md`、`docs/active/tool-gated-autonomy.md` 与 book 第 5/11 章；
- documentation map 已覆盖 policy/execution、MCP 和计划治理影响；
- 没有新增架构决策；实现遵循 accepted ADR-0054 与 ADR-0061，未改写 accepted ADR 历史。
