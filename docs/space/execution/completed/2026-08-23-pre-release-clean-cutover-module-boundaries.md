# 发布前无版本 Clean Cutover 与领域模块边界完成记录

状态：completed

日期：2026-08-23

权威来源：用户提供的《Kite Code 完整模块化优化方案》、当前源码与测试、
`docs/active/`、ADR-0128、
[`2026-08-23-pre-release-clean-cutover-module-boundaries.md`](../../plans/2026-08-23-pre-release-clean-cutover-module-boundaries.md)

实施起点：`a7756d8d958831c914f38e91f24bb523e9ec00e9`

Final implementation/documentation SHA：本记录所在提交；为避免自引用改变 Git commit SHA，不在文件内写入该值。

## 1. Clean cutover 结果

- 生产文件、声明与 package export 使用当前无版本名称；旧名不保留 alias、双路径、fallback 或 façade。
- MCP 配置只保留 user `~/.kite-code/mcp.json`、project `.kite-code/mcp.json` 与 caller-authorized explicit config；旧 source/migration/ambient auth 路径删除。
- App production storage 只使用 `sessions`、`transactions`、`effects`、`checkpoints`、`recoveryIdentities` 嵌套端口；flat test fixture 只存在于 `scripts/support/`。
- TUI 只经 typed session adapter 进入 App，旧 `any` session façade 删除；App Runtime 不依赖 TUI 展示类型。
- Host/Builtin 根 API 已收窄，Kernel adapter、storage、skills、verification、subagent 与 capability 使用明确 subpath。

## 2. 模块拆分与唯一 Owner

- Runtime Contract 拆为 commands、queries、notifications、projections；Runtime SPI 拆为 capability、execution、model、modules，旧 `contracts.ts` 删除。
- Agent Kernel 的 planning、context、verification state/event 迁入静态 domain，根 state/event 只做编译期组合。
- Runtime Host 迁入 host、lifecycle、execution、process、format、storage、kernel-adapter；原平铺文件全部删除。
- Builtin Runtime 的 git、model、planning、subagent、verification operation 迁入各 domain 的 `runtime-module.ts`。
- App session manager、tool execution 与 tool persistence 按职责拆分；SQLite adapter 拆为 schema、connection、event/session/snapshot/artifact、authority ledger、effect leases 与 transaction。
- `apps/kite/src/bootstrap.ts` 仍是唯一 concrete composition root；七 workspace 与 12 条允许依赖边保持不变且无环。

## 3. 保持的语义与真实根因修复

State26、Store5、单 Store transaction、ack-before-dispatch、receipt-before-terminal、effect lease、restart recovery、sandbox cleanup、MCP protocol、Subagent suspension/resume、Model streaming inactivity timeout 与 structured exhausted-retry terminal 均保持。

验证期间只修复了实际复现的问题：搜索默认根被误写为父目录、test storage 未投影 Host
lease/transaction 端口、MCP E2E 仍写旧配置位置、release/workflow 仍引用旧 export/文件路径、tests
仍从已收窄 root API 动态导入，以及 clean cutover 后 Windows restricted-token runner 的可复现 binary
digest pin 漂移。最终资格期间还复现并修复了 fatal Model Provider rejection 被展示为 `unknown` 的
投影错误；4xx 仍不可重试，只改用已有 failure taxonomy。没有引入密钥、HMAC、第二 authority、
compatibility layer 或推测性安全设计。

## 4. Manifest 与静态门禁

- `legacy-delete.json` 的 107 条规则全部为 deleted；source migration 的旧 source 为 0；architecture exception 为 0。
- generated State/Event/Store/package graph/public exports 可重复生成并与工作树一致。
- `check:pre-release-architecture` 检查生产版本命名、任务编号、旧名称、compatibility path、root/subpath 误用、Runtime→TUI 反向依赖、领域文件与唯一 composition root，结果为零违规。

## 5. 本地 Required Gate

| Gate | 结果 |
| --- | --- |
| `bun run typecheck`、`bun run build` | passed；七 workspace |
| `bun run format:check`、`bun run lint` | passed；既有 warning、0 error |
| runtime package/core/pre-release architecture/docs/docs-impact/manifests | passed；7 workspace、12 edge、1 composition root、0 architecture exception |
| `bun run test` | passed；root 3489 pass / 6 skip / 0 fail，隔离测试与七 workspace tests 全过 |
| `bun run test:tui:system` | passed；39 个隔离 PTY scenario |
| `bun run test:runtime:fault` | passed；35 pass / 0 fail |
| `bun run test:runtime:soak` | passed；7/7 case、0 fail、无 orphan PID/worktree/residual path |
| `bun run release:build`、`release:verify`、`release:smoke` | passed；verify/install/CLI/TUI/MCP/upgrade/rollback/uninstall 全过 |
| `git diff --check` 与正常 pre-commit hooks | passed；未使用 `--no-verify` |

## 6. Final SHA GitHub 证据

本记录所在 final SHA 必须运行并通过以下 GitHub Actions：

- Platform Capability Probe：macOS、Ubuntu、Windows native matrix；
- OSS Release Candidate：受支持平台候选构建、验证与 smoke；
- Runtime Resilience Qualification：固定 seed、正式 measured attempts、独立 verifier 与 artifact。

三个 workflow 的 `headSha` 必须精确等于本记录所在提交。三项通过后不再创建后续提交；最终任务报告记录 SHA、run URL、远端同步与干净工作树证据。

## 7. 完成裁决

实现、当前文档、计划/完成记录、本地 Gate、正常提交/推送与第 6 节 final-SHA 外部证据共同构成本任务的完成条件。该条件闭合后，ADR-0128 的 clean cutover 实施完成；历史版本号仍只在 accepted ADR、历史计划/完成记录与 schema/protocol metadata 中存在，不构成 production compatibility path。
