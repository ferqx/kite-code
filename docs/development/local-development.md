# 本地开发与验证

仓库使用 Bun；CI 与正式 qualification 固定 Bun 1.4.2。先 `bun install --frozen-lockfile`，再 `bun run build` 构建精确八个新 workspace。正式源码入口依赖完整候选，运行前执行 `bun run release:build`；显式开发入口使用已构建 Service。当前资格范围见[进度证据](../plans/unified-agent-refactor-v1-progress.md)。

| 目标 | 命令 | 说明 |
| --- | --- | --- |
| 正式 Terminal 候选 | `bun run release:build` | 生成 `dist/unified-terminal`；实际 SQLite 引擎选择与依赖条件见 Terminal owner |
| TUI | `bun run tui --workspace .` | 固定新 Terminal 候选；stdin/stdout 均须为 TTY |
| CLI | `bun run agent run --workspace . --task "任务"` | 同一候选的公开 Client；模型配置与工作区信任仍须满足 |
| 正式 daemon/Web | `bun run server` | 先显式启动候选 daemon，再读取 Web 地址；不自动构建缺失资源 |
| CLI 开发 | `bun run cli:dev run --task "任务"` | 已构建 Service 与独立 development profile |
| TUI 开发 | `bun run tui:dev --workspace .` | 同一 development profile 与 Ink；`--thread <id>` 选择原 Session |
| 只读 Web 开发 | `bun run web:dev` | 已构建 Service/Web assets、development profile 与只读 Gateway |
| 完整 Native 候选 | `bun run release:build --product native` 后 `bun run desktop` | 验证完整 Native、内嵌 Terminal/Bun 与实际 Electron Node；不依赖旧 Vite/配套服务 |
| Desktop 定向验证 | `bun run test:desktop:native` | 新 Native bundle/process/Files 的隔离实际场景，使用本地固定 Provider |
| Native 安装生命周期 | `bun run test:desktop:window` | 新完整 Native 的源码外安装、升级、强杀、回滚与卸载；具体资格见 Native owner |
| 默认测试 | `bun run test` | 与 `test:unified-agent` 共用新八 workspace 和有限 root safety 计划，最多四槽；独占场景串行 |
| TUI 系统测试 | `bun run test:tui:system` | 新 28 个文件；支持定向选择和 4×7 分片，详见测试 owner |
| 类型检查 | `bun run typecheck` | 根与精确八 workspace |
| 文档 | `bun run check:docs`、`bun run check:docs-impact` | 结构检查与实际影响语义核对 |
| 首发证据 | `bun run check:plan-evidence` | 独立历史证据消费者，不代替当前 §35 资格 |

正式 Terminal 默认使用 `~/.kite-code/unified-agent/default`，开发入口默认使用 checkout 的 `.kite-code/unified-development/development`。可用 `--data-root <绝对路径>` 明确隔离；当前入口不读取旧 Kite Home 配置或数据库，也不自动迁移旧用户数据。测试必须使用所属临时 home/workspace/profile/endpoint，按 harness 清理。

`cli:dev`、`tui:dev` 和 `web:dev` 验证实际 Bun 与已构建 Service 的 SHA，通过私有 bootstrap 准入。缺资产局部失败；help/version 与严格参数拒绝先于 Profile 或 Provider I/O。开发 entry SHA 只标识所选入口，完整发行资格另行核对。

开发 CLI 的 `run/resume` 消费公开 Client；`resume` 在原 Session 输入新任务，冷接续原 Run 使用明确 recovery 命令。`--skill` 只选已配置知识，Workflow 使用明确 `--activate-skill`。首次 mutation 前保存完整原申请，回执未知只查原 ID。stdin EOF 保留原待人工作；Ctrl+C 精确取消原 work。显式 `--server` 连接所选 data root 的原共享服务，不读取本地 Service 资产。`caller list` 和 `files intents` 仍先连接服务，不是离线查询。参数和退出码见[CLI 手册](../handbook/cli/commands.md)，真实 argv 证据见[CLI owner](../../apps/cli/README.md)。

开发 TUI 的 `Ctrl+R` 选择 Session，`Ctrl+N` 创建同 Workspace 新 Session，`Ctrl+K` 查原未知 Command，`Ctrl+C` 精确取消原工作。stdin EOF、PTY 关闭和 SIGHUP 停止输入与观察；`Ctrl+Q` 或明确 SIGTERM 关闭本宿主拥有的 paired Service。当前命令与持久草稿、Files 恢复和终态等待见[命令参考](../handbook/clients/tui/reference/commands.md)及[CLI/TUI owner](../../apps/cli/README.md)。macOS 的 28 文件真实 runner 已通过，不能据此取得 Linux/Windows 或完整 §35 资格。

`web:dev` 使用新只读 Gateway，不发现旧 daemon。它只接受可选 `--data-root <绝对路径>`，stdout 输出 Browser 地址。关闭浏览器结束读取；launcher EOF、Ctrl+C 或 SIGTERM 清理其所属 Service/Gateway。只读范围和资产条件见[Web owner](../../apps/web/README.md#新开发-web-宿主入口)。

## 制品与启动验证

[`ensure-web`](../../scripts/development/ensure-web.ts) 先验证两个闭合 CLI 调用，再经固定 Terminal 依次执行 `server start` 和 `web`；任一步非零即保留退出码。回归见[release tools 测试](../../tests/isolated/unified-agent/release-tools.test.ts)，显式服务操作见[生命周期](../handbook/server/lifecycle.md)。源码入口忽略安装登记；已安装标准前门可按明确 nonce 登记 Native，具体规则见[Native owner](../../apps/desktop/docs/native-release.md)。

Terminal 的构建、归档、安装和 lease 见[终端制品说明](../../apps/cli/docs/terminal-release.md)。SQLite 发布必须实际选择已审查引擎并核对 sourceId；macOS 复制明确构建依赖或 `--sqlite-library`，不安装系统依赖。未选引擎的开发源码仍 unqualified，不能用于解释或改写正式候选 WAL。

平台支持、完整默认 Shell、原生 Windows 和发行证明分别按[发布边界](../active/release-control.md)核对。当前完整默认 effectful platform 缺资格会被 formal verifier 拒绝，进程监督不能被称为操作系统沙箱。

## 修改与验证

先运行所属 workspace 的相关测试。跨包协议、持久化、授权或恢复变化再扩大到对应边界与 qualification；Web build 不能代替 TUI PTY，fixture 通过不能外推原生平台支持。测试分层和真实模型调用约束见[测试入口](../../tests/README.md)。只修改文档不默认调用真实 Provider 或外部服务。

Required quality job 运行 `bun run format:check`（Biome check），同时检查格式、imports 和启用的 lint；hook 的 staged 输入、平台与制品资格仍独立验证。失败先核对产品要求、当前合同和实际断言，不能削弱仍有效的约束。CLI 参数变化同步手册和相关测试，不提交本地 checkpoint、临时产物或密钥。

生产 TypeScript 不用 `as any` 绕过约束，也不以 `as unknown as T` 代替判别联合守卫；`catch` 未知错误先收窄。外部 SDK 必要断言限制在适配边界并说明原因，测试 mock 不扩散为生产接口。`man` 的直接提交由[本地分支守卫](../../scripts/check-protected-branch.ts)和 [Required workflow](../../.github/workflows/required.yml)限制，合并/cherry-pick 按实际守卫核对。
