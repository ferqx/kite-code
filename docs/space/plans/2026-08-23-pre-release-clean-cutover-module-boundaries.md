# 发布前无版本 Clean Cutover 与领域模块边界计划

状态：archived

日期：2026-08-23

权威来源：用户提供的《Kite Code 完整模块化优化方案》、当前源码与测试、
`docs/active/`、ADR-0128。

实施起点：`a7756d8d958831c914f38e91f24bb523e9ec00e9`

完成记录：
[`2026-08-23-pre-release-clean-cutover-module-boundaries.md`](../execution/completed/2026-08-23-pre-release-clean-cutover-module-boundaries.md)

## 目标与约束

- 保持现有七 workspace 与依赖方向，不新增 workspace；`apps/kite/src/bootstrap.ts` 是唯一 concrete composition root。
- 在未发布阶段直接切换到无版本生产名称，不保留旧名 alias、双路径、fallback、版本 façade 或长期 allowlist。
- schema/protocol/version 只作为 metadata 数据存在；不改变 State26、Store5、transaction、ack/receipt/terminal、recovery、sandbox、MCP、Subagent、Model streaming inactivity timeout 与 structured retry terminal 语义。
- 只修复验证真实复现的根因，不引入密钥、HMAC、第二 authority、兼容层或推测性威胁模型。

## Owner / Delete / Rename / Split / Gate 控制表

| 控制项 | Owner | 计划动作 | 完成证据 |
| --- | --- | --- | --- |
| State/Event | Agent Kernel | planning/context/verification 按静态 domain 拆分 | domain source、Kernel tests、manifest shape |
| Host lifecycle/process/state adapter | Runtime Host | 迁入 host/lifecycle/execution/process/kernel-adapter subpath，收窄根 API | package exports、runtime package Gate、Host tests |
| Builtin operation | Builtin Runtime | 迁入 git/model/planning/subagent/verification domain，删除旧 operation 文件 | module registry、public export manifest、Builtin tests |
| App session/tool orchestration | App | 拆分 session manager、tool execution、tool persistence；TUI 只经 typed adapter | App/TUI tests、pre-release architecture Gate |
| Store | SQLite adapter | schema/connection/session/event/snapshot/artifact/ledger/lease/transaction 分责 | Store tests、Store manifest、transaction tests |
| Compatibility | 对应当前 owner | 删除旧 MCP source、flat storage、TUI any façade、旧 root import 与版本路径 | legacy-delete/source-migration manifest、静态 Gate 零违规 |
| Documentation | repository docs | ADR、active docs、package README、documentation map、计划与完成记录同步 | docs-impact、docs Gate、document-before-commit |

## 执行阶段

1. 机械核验 package exports、依赖图、版本命名、compatibility/legacy 路径、巨型模块职责与测试。
2. 完成无版本 rename/delete，并同步所有消费者、exports、tests、docs、workflow 与 release entrypoint。
3. 按唯一 owner 拆分 Contract、SPI、Kernel、Host、Builtin、App 与 SQLite；不复制 authority。
4. 收窄 Host/Builtin 根 API，消费者改用明确 domain subpath。
5. 建立 `check:pre-release-architecture` 零违规门禁并更新可重复生成 manifests。
6. 运行七 workspace typecheck/build/test、默认测试、TUI system、fault、soak、release smoke 与文档门禁。
7. 正常提交并推送当前分支；在 final SHA 上完成 GitHub native、OSS、resilience qualification。

本计划已按上述完成记录归档；当前行为只以源码、测试、`docs/active/` 与 accepted ADR 为准。
