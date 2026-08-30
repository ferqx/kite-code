# 单维护者开源首发规则

状态：active

读取时机：修改发布脚本、安装器、候选版本 workflow、生产路线图、Task 状态或首发能力边界时。

验证：`bun test packages/kite-local-runtime/test/isolated/service-state.test.ts tests/release/oss-candidate.test.ts tests/release/oss-install.test.ts tests/release/supply-chain-workflow.test.ts`、`bun run release:build`、`bun run release:verify`、`bun run release:smoke`、`bun run check:docs`。

相关：ADR-0068、ADR-0069、ADR-0093、`release/oss-first-release/task-status.json`、`.github/workflows/release-candidate.yml`。

首发 Gate、候选构建命令和限制以本文件及 `release/oss-first-release/` 为权威，不要求在面向使用者的
`README.md` 中重复维护。

## 首发 Gate

`G0` 只判断本地正确性和安全：规范测试通过；Workspace 越界、secret、network、MCP write、
destructive/unknown effect 与 Verification false pass 继续 fail closed；P0/P1 为零；安装、卸载与回滚
smoke 通过。

日常 PR 的 Required workflow 是首发候选前的合并门禁。其中真实 TUI PTY suite 仅在单个 runner 内串行；
CI 将默认 scenario 清单稳定分到四个相互独立的 runner，并由同名 `tui-system` 汇总 gate 在所有分片成功后
才报告成功。这不会将 PTY 并发或单个分片通过误作完整 G0 证据。

当前版本不包含 evaluation、record/replay baseline 或真实 Provider smoke job。后续重新建立 evaluation 时必须
以新的计划、数据边界和独立门禁重新准入，不能恢复已删除脚本或把产品 replay/restore 语义当作评测框架。

Required workflow 同时覆盖 `main`、`compact` 与 `man`；其中 `man` 的单父直接推送会失败，只接受通过
Pull Request 产生的合并提交。本地 pre-commit 守卫提供更早的反馈，远端分支保护仍是最终写入控制面。

`G1` 只判断普通发布可用性：GitHub-hosted macOS、Ubuntu、Windows 原生构建、安装、启动和
TUI/CLI smoke 通过；release notes 与已知限制和候选内容一致。

任一测试失败或缺失三平台 run 时，结果保持未验证或 blocked，不得包装成成功。

Store generation migration不是安装器或候选自动upgrade步骤。fresh home由normal ensure直接创建Store 8；已有Store 7仍只走显式offline
maintenance，不在release smoke中隐式迁移。Store 8 Worker/reopen的本机candidate smoke已通过，但三平台filesystem/process evidence完成前仍不计入G1；
旧candidate/Store 7 Worker必须fail closed，不能由installer rollback或runtime fallback绕过data-generation write fence。

首发terminal拓扑已经切到managed Local Runtime Service：本地TUI与用户在场的foreground CLI都是Native client，
默认唯一Host/Store/Builtin/History/App Control composition位于`apps/kite-service`。private loopback Web Observer 由独立
Gateway companion、Coordinator 与 Workspace Worker 组合；Service-owned internal stdio、development loopback WebSocket、
browser与Desktop reference不等同于remote/public Web access。
KLSV1-06的本地源码、candidate与smoke evidence不能计作G1三平台成功；KLSV1-07的macOS、Ubuntu、Windows installed
companion/process结果取得前保持pending qualification。当前macOS arm64本机candidate build/verify以及安装、
CLI/TUI、Service/Coordinator/Worker/Gateway companion assets、Web payload、MCP wrapper、升级、回滚、卸载smoke已通过，但它只是单平台
dirty-source开发证据；真实
Windows ACL/locked-directory atomic publication与三平台 qualification 仍未取得。

## 制品与安装

`bun run release:build`为当前平台编译`kite` CLI、`kite-tui`、`kite-service`、`kite-coordinator`、`kite-worker`、
`kite-web-gateway` companions，并生成 `payload/web` 静态资产；其中固定`api-docs/openapi.json`逐字节来自canonical Agent API OpenAPI，
是verifier、installer preflight与smoke共同要求且由manifest checksum绑定的必需asset。所有制品共享 candidate identity，另生成 gzip tar、严格 manifest、
逐文件 SHA-256 和 archive SHA-256。checksum 是完整性信息，不是签名、notarization、provenance 或
attestation。构建只允许当前 OS/architecture 的 native target；macOS、Linux、Windows 各自由对应
GitHub-hosted runner 生成，不通过 cross-compile 或候选构建期 runtime 下载替代真实平台验证。PR workflow
显式 checkout `pull_request.head.repo.full_name` 的 `pull_request.head.sha`，并要求 manifest `commitSha` 与
该 SHA 完全一致；不得把临时 merge ref 登记为最终候选提交。fork PR 只以只读权限构建其自身 head repository。
归档 writer 会规范化 tar entry 时间戳并重算 header checksum；相同 target、manifest 和文件内容
必须生成字节一致的 `.tar.gz`，不能让构建墙钟改变候选 SHA-256。
Standalone build resolver机械覆盖十五个workspace package的全部public export，包括Service当前消费的browser-safe
`agent-api-contract`；resolver直接指向repository source，不能经`node_modules/@kite-ai/*` workspace symlink解析。

`bun run release:verify` 在执行 payload 前检查 archive 文件集合、manifest schema、目标平台和全部
checksum；CI额外传入`--require-clean-source`，拒绝上传从dirty worktree生成的候选。`bun run release:smoke`在
临时prefix中完成安装、CLI help/version、已安装standalone TUI通过managed Service的真实PTY startup、installed
companion MCP stdio wrapper、第二候选安装、回滚和卸载。候选先写入并验证`releases/<candidateId>.next`，再原子
改名到 immutable 最终目录。v2 managed-install marker 与唯一 `active` pointer 原子绑定当前/previous candidate；
stable launcher 将启动时的 candidate root pin 给 child process，running process 不重新读取 pointer。首次安装才以
atomic copy 创建 `bin/kite`、`bin/kite-tui`、`bin/kite-service`、`bin/kite-coordinator`、`bin/kite-worker`、`bin/kite-web-gateway`
stable launchers；upgrade/rollback 只验证既有
launcher identity，不逐文件替换或停止仍在运行的旧 candidate。只有 destructive uninstall 才执行 ordinary Service
stop、确认 state absent 并取得 Native lifecycle fence；busy、unknown、残留state或identity不确定时active candidate
保持不变。upgrade还拒绝跨 OS/architecture target替换。安装器只修改带自身marker的显式prefix；目标为根目录、用户home、
符号链接或不匹配 marker时拒绝覆盖、回滚或删除。

当前候选 manifest 的 `releaseSlots` 已绑定 CLI、TUI、Service、Coordinator、Worker、Gateway 与 Web entrypoint/identity；这些
independent asset identities 不等于三平台 process/runtime qualification。Windows resolver 只接受 v2 marker、唯一 `active` regular-file
pointer、immutable candidate 与 exact identity，并对 runner/marker/pointer/runtime 执行 no-follow 校验。POSIX rename
后会 flush 父目录；Windows launcher、active pointer与marker统一通过locked-directory ordinary atomic publish落盘。partial publish会因
marker/pointer/checksum不一致fail closed；installer不把hosted虚拟磁盘高延迟的write-through或`FlushFileBuffers`作为安装正确性前提，
也不依赖Bun `fsync`；其locked-directory publication、ACL 与
三平台安装/运行 qualification 仍须 hosted/真实证据，
不能以本地结果代替。

首发预构建架构为 macOS arm64、Linux x64 与 Windows x64；其他架构可以从源码运行 Bun，但没有首发
预构建候选包。候选 workflow 不签名、不发布 Release、不上传 secret。它在三个 GitHub-hosted runner 上构建并运行
同一 smoke；Windows runner还会在构建前执行Service state current-user ACL/non-reparse owner test及ACL drift负向断言，
该process-global/child-process owner suite固定置于`packages/kite-local-runtime/test/isolated/`并由workflow串行运行，
随后上传候选 artifact 供维护者检查。正式公开 Release 与 npm publish 不属于该 workflow。

## 能力边界

- Manual Compaction、本地 Verification、MCP write 与 Skills 的 conformance/security Gate 保留。
- capability profile 只能收紧 embedded ceiling；项目配置和模型输出不能扩大它。
- MCP write、effectful Skills、remote telemetry 和其他高风险能力默认关闭，需要本机用户显式开启并
  继续通过运行时 admission。
- Auto Compaction 首版不受支持并默认关闭；未来若要启用必须重新立项。
- remote/LAN Web、多租户、托管 runner、服务端 credential custody、无人值守共享 writer 和远程发布控制面明确不受首版支持；
  private loopback Web Observer 仅在对应 companion、layout 与 hosted qualification 闭合后宣称支持。

## 明确移出路线图

项目不规划第三方评审 Gate、Sigstore/OIDC、SLSA/provenance、平台发布者签名、企业 SBOM
attestation、external cohort、长期服务等级/error-budget、dogfood/canary/maturity promotion、独立
Release/Security 人员或 production evaluator authority。旧 fail-closed contract 可以保留为历史安全
资产，但不再形成 Task、milestone、产品能力或未来承诺，也不得出现在 G0/G1 的通过声明中。

## 状态权威

`release/oss-first-release/task-status.json` 精确覆盖原 108 个 Task。当前终态为 83 `completed`、
25 `superseded`、0 optional；不存在 pending、in-progress 或发布后路线图 Task。各旧 Phase 计划保留
Task 说明和历史证据，但其 execution binding 与 milestone 不再决定发布状态。
