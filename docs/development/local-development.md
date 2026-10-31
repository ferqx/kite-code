# 本地开发与验证

仓库使用 Bun；Linux/macOS CI 与正式 qualification 保持 Bun 1.4.2，Windows CI 固定 Bun 1.4.3，以采用固定 tsconfig 的上游修复。先 `bun install --frozen-lockfile`，再 `bun run build` 构建精确八个新 workspace。正式源码入口依赖完整候选，运行前执行 `bun run release:build`；显式开发入口需要已构建的 workspace 资产，Desktop 另从当前 Service 源码构建独立开发版本。当前资格范围见[进度证据](../plans/unified-agent-refactor-v1-progress.md)。

源码安装的 postinstall 会构建 [Files Node-API companion](../../packages/agent/native/files/README.md)，期间显示三个构建阶段及实时 Cargo 诊断，完成后显示资产路径。需要 rustup／固定 Rust1.97.1 和本机 linker；Windows x64 使用 MSVC Build Tools，macOS 使用 Xcode Command Line Tools，Linux 使用 GNU C 工具链。使用 `--ignore-scripts` 安装后，先显式运行 `bun run build:files-native` 再执行文件工具测试。正式 Agent build 会把同一原生模块、ABI/hash manifest 和许可证放进制品；用户机器不需要 Rust。运行期缺失资产明确失败，不能依靠源码或即时编译回退。

| 目标 | 命令 | 说明 |
| --- | --- | --- |
| 正式 Terminal 候选 | `bun run release:build` | 生成 `dist/unified-terminal`；实际 SQLite 引擎选择与依赖条件见 Terminal owner |
| TUI | `bun run tui --workspace .` | 固定新 Terminal 候选；stdin/stdout 均须为 TTY |
| CLI | `bun run agent run --workspace . --task "任务"` | 同一候选的公开 Client；模型配置与工作区信任仍须满足 |
| 正式 daemon/Web | `bun run server` | 先显式启动候选 daemon，再读取 Web 地址；不自动构建缺失资源 |
| CLI 开发 | `bun run cli:dev run --task "任务"` | 已构建 Service 与独立 development profile |
| TUI 开发 | `bun run tui:dev --workspace .` | 同一 development profile 与 Ink；`--thread <id>` 选择原 Session |
| Desktop 开发 | `bun run desktop:dev` | 已准备 workspace 资产、已安装 Electron；检查运行时依赖加载与真实 Service 就绪，UI 热更新，Service 及其 workspace 源码变更自动重载 |
| 只读 Web 开发 | `bun run web:dev` | 已构建 Service/Web assets、development profile 与只读 Gateway |
| 完整 Native 候选 | `bun run release:build --product native` 后 `bun run desktop` | 验证完整 Native、内嵌 Terminal/Bun 与实际 Electron Node；不依赖旧 Vite/配套服务 |
| Desktop 定向验证 | `bun run test:desktop:native` | 新 Native bundle/process/Files 的隔离实际场景，使用本地固定 Provider |
| Native 安装生命周期 | `bun run test:desktop:window` | 新完整 Native 的源码外安装、升级、强杀、回滚与卸载；具体资格见 Native owner |
| 默认测试 | `bun run test` | 与 `test:unified-agent` 共用新八 workspace 和有限 root safety 计划，最多四槽；独占场景串行 |
| TUI 系统测试 | `bun run test:tui:system` | 当前 112 个完整文件（原 52 个旅程及 60 个当前宿主文件）；支持 `--list` 和 `KITE_TUI_SYSTEM_SHARD=0/4` 至 `3/4`，详见测试 owner |
| 类型检查 | `bun run typecheck` | 根与精确八 workspace |
| 工作区与依赖边界 | `bun run check:runtime-packages`、`bun run check:core-boundary` | 工作区清单、正式消费闭包与源代码依赖边界 |
| 文档 | `bun run check:docs`、`bun run check:docs-impact` | 结构检查与实际影响语义核对 |
| 首发证据 | `bun run check:plan-evidence` | 独立历史证据消费者，不代替当前 §35 资格 |

`check:runtime-packages` 检查八个工作区的清单、公开 exports、正式脚本和 CI 消费闭包，并调用与 `check:core-boundary` 相同的[依赖边界守卫](../../scripts/check-unified-agent-boundary.ts)。守卫在每次调用内复用已解析的模块依赖图，各入口仍按自己的策略遍历；仅在导入或违规处计算行号。下一次调用重新读取源码和清单。回归覆盖[共享与循环依赖及入口策略](../../tests/isolated/scripts/unified-agent-boundary.test.ts)、[工作区合同](../../tests/integration/scripts/unified-workspaces.test.ts)和[CI 消费闭包](../../tests/integration/scripts/unified-ci.test.ts)。

正式 Terminal 默认使用 `~/.kite-code/unified-agent/default`。CLI、TUI、Desktop 和 Web 开发入口的默认数据根为当前用户的 `~/.kite-code`，与 checkout 和启动工作目录无关；其 `development` profile 位于 `~/.kite-code/development`，数据库直接位于 `~/.kite-code/development/core.db`，会话、制品、草稿和偏好随 profile 保存。CLI/TUI/Web 可用 `--data-root <绝对路径>` 明确选择其他数据根，优先于默认值。原 checkout 的 `.kite-code/unified-development` 数据保持原位，不自动迁移；需要读取时显式选择该旧数据根。模型配置仍统一读取 `~/.kite-code/kite-code.jsonc`。测试必须使用所属临时 home/workspace/profile/endpoint，按 harness 清理。

日常开发可使用 npm 调用同一 Bun 脚本：

```sh
npm run build
npm run cli:dev -- run --workspace . --task "任务"
npm run tui:dev -- --workspace .
npm run desktop:dev
```

四个开发入口使用同一 development profile；任务仍需要已配置模型和工作区信任。CLI/TUI 修改代码后退出客户端，重新执行 `npm run build` 并启动。Desktop 每次启动编译 Main/preload，在 checkout 的 `.cache/unified-desktop-*` 临时应用目录运行，由本地 Vite 提供 renderer；退出后清理该次应用目录和开发服务器，会话、设置和显式保存的草稿保留在用户目录的开发 profile。

Windows 数据目录若被其他程序增加授权（例如 Agent 沙箱读取组），Desktop 会在启动 Service／SQLite 前显示准确路径和处理选项，默认退出；符合有限安全条件时可主动备份并修复该对象，操作见[桌面手册](../handbook/clients/desktop/README.md)。取消后开发命令返回 `native_profile_permissions_cancelled`，不删除 Profile。验证权限错误须使用测试自有的数据根，不在真实用户目录制造故障；正式 Native 默认数据根 `~/.kite-code/unified-agent` 与开发入口保持独立。

`desktop:dev` 在启动 Electron 前，用独立 Bun 进程加载实际 Service 版本及其外部 workspace 导入；不执行入口的 `import.meta.main` 分支，不启动业务服务，不自动安装缺失依赖。缺失导出或模块加载失败会阻止启动，并在终端保留具体加载诊断。Electron 的父控制连接只有在实际 Service 握手、连接及 Native caller 初始化成功后才报告就绪；初次失败返回非零并等待所属进程退出，再清理应用目录。打开窗口或启动 Vite 不表示后台就绪。这不是完整类型检查或任意业务逻辑验证。

页面、组件和样式（包括共享 UI）使用 Vite／React Fast Refresh，保存后即时更新，通常保留组件的页面状态；不能进行 Fast Refresh 的模块由 Vite 重新加载。Service 以及 Agent、AI、Client 的 `src` 源码保存后合并连续变更，构建到新的私有 Service 版本并再次检查运行时加载；同时比较这些源码的内容摘要，外部依赖变化不会因入口字节未变而被跳过，内容未变不重启。检查失败保持旧服务，修正保存后可再次检查。在同一 Electron 窗口内关闭并核实旧配套服务实际退出，再按新 SHA／build 身份准入新服务并重载页面。运行中的开发任务会正常取消和收尾，不自动重发或接续；Service 重载会重置页面内存中的未保存状态，持久数据保留。

开发 Service 的 Shell 资产定位器使用当前 checkout 已构建的 Agent 入口，主 Agent 和默认通用／code 子 Agent 因而能够在宿主资产可用时取得 Shell；其余工作区代码继续使用源码。修改开发构建脚本或更新 Shell 资产后，退出并重新运行 `desktop:dev`；资产未准备时先执行 `npm run build`。该选择不改变工作区信任和审批要求，具体装配与回归归 [Desktop owner](../../apps/desktop/README.md#开发热更新与服务重载)。

Vite 以 middleware 模式接入宿主拥有的 loopback HTTP／WebSocket 服务，不另接管 SIGTERM 或 stdin EOF。退出由开发宿主统一收尾，信号处理器保留到清理完成，等待所属 Electron 退出后再删除该次应用目录。Service 编译／加载检查失败时旧服务继续运行，修正代码再保存即可重试。启动、收尾或回执无法确认时终端报告失败，停止该实例的后续自动切换；请完全退出并重新运行开发命令后检查结果。Main／preload、原生模块、workspace Worker 资产或依赖清单变更仍需退出后重新启动；需要更新包资产时先执行 `npm run build`，依赖清单变更先安装依赖。UI／Service 热更新只属于显式开发入口，正式 Native 仍加载固定制品。实现与验证归[Desktop owner](../../apps/desktop/README.md#开发热更新与服务重载)。

切换分支或 workspace 清单变更后，先重新执行 `bun install --frozen-lockfile`，确保 `node_modules/@kite-ai/*` 链接当前八个 workspace；缺少这些链接会在启动前报 `Cannot find module '@kite-ai/cli/host'`。

Windows x64 的 Desktop 开发入口还会构建 Node 原生权限模块，需要已安装 [Microsoft C++ Build Tools](https://learn.microsoft.com/en-us/cpp/overview/acquire-msvc) 的 C++ 桌面开发工具和 Windows SDK。普通 PowerShell 可直接启动：

```powershell
npm run desktop:dev
```

[开发环境准备](../../scripts/development/windows-desktop-environment.ts)先复用完整的 x64 C++ 构建环境；否则通过 Visual Studio Installer 自带的 [vswhere](https://github.com/microsoft/vswhere/wiki/Examples) 定位最新已安装 C++ 工具，再调用 `VsDevCmd.bat -arch=x64 -host_arch=x64`。仅将编译所需的环境白名单导入本次进程，核编译器与 Windows SDK 文件，设置 canonical absolute `KITE_WINDOWS_MSVC` 并清空 `CL`／`_CL_` 注入参数；调用者的 PowerShell 和系统环境不变。已有显式编译器路径保留，路径无效返回 `windows_desktop_compiler_override_invalid`。

帮助、严格参数拒绝和缺应用资产先于工具探测；准备失败不创建该次应用目录或进入 Profile。缺 C++ 工具或 SDK 返回 `windows_desktop_build_tools_unavailable` 并提示安装，初始化失败返回 `windows_desktop_build_environment_failed`；入口不自动安装系统工具。应用临时目录继续由 Windows 原生权限接口创建，满足 Native 构建器的私有 ACL 校验。此自动准备仅用于 `desktop:dev`，正式 Native 构建仍按其 owner 要求提供明确编译环境。

Windows 的 `desktop:dev` 在构建／创建应用目录前执行 [Electron 权限预检](../../scripts/development/windows-electron-permissions.ts)：解析当前安装包和实际 `electron.exe`，核对 `dist/version` 与包版本，逐项检查公开运行资源的 ACL。缺少 `ALL RESTRICTED APPLICATION PACKAGES`（`S-1-15-2-2`）读取／执行权限时，自动向该物理 `dist` 及其现有文件／子目录补齐非继承 RX，并输出修复项数；已具备权限时保持只读。重新安装或切换 Electron 版本后，下次启动自动检查新目录，无须重做手动授权。此项处理[上游报告的 Windows 沙箱初始化问题](https://github.com/electron/electron/issues/51761)，其典型表现为 GPU／renderer 在页面前以 `-2147483645`（`0x80000003`）退出。

预检固定目录与文件句柄，在任何 ACL 写入前拒绝目录联接、符号链接、硬链接及该 SID 的显式拒绝。仅追加缺少的 RX，不重置原 ACL、所有者或继承设置；包目录、项目源码、开发应用目录、Profile、数据库和正式候选的权限不变。该读取权限也允许其他受限应用包读取这份公开 Electron 发行资源，不授予写入权限。浏览器沙箱、上下文隔离和原生数据私有校验保持启用；非 Windows 平台跳过 ACL 准备。

范围异常返回 `development_electron_runtime_scope_invalid`，显式拒绝返回 `development_electron_permissions_denied`，无权修复或检查失败返回 `development_electron_permissions_failed`；入口停止启动，不自动提权、不覆盖拒绝规则。请确认 Electron 是当前依赖安装生成的独立物理目录及本用户有修改其 ACL 的权限，再重装依赖或修复安装策略后重试。帮助、无效参数和缺 built Service 仍先于这一步返回。

`tui:dev`、`desktop:dev` 与正式客户端强制使用普通用户界面，测试专用调试功能不得在 dev／prod 出现。TUI 公开参数拒绝 `--test-ui-diagnostics`；自动化只能从测试目录的入口向可信 host 显式传 `testDiagnostics:true`。Desktop 开发和普通正式 renderer 的构建常量固定为 false，传入组件参数也不能开启；DOM fixture 或单独测试制品可以显式启用。共享 UI 不以 `NODE_ENV` 等环境名自动开启诊断。测试诊断只影响展示，原权限、scope、未知结果和制品校验不变。

`npm run agent`、`npm run tui`、`npm run desktop` 仍选择正式候选。首次运行这组命令，先执行 `npm run release:build`，再执行 `npm run release:build -- --product native` 生成 Desktop 候选。缺失候选时分别返回 `terminal_bundle_unavailable`／`native_bundle_unavailable` 和准备命令，未通过完整验证时不进入 Profile。源码变化不会自动更新候选；需要重新生成时，先退出使用它的客户端，将旧候选目录移出默认路径，再构建新的候选。构建不覆盖正在使用或已有的目录。

2026-10-26 已删除旧 Desktop、Service、Web 及旧 Runtime/Kernel/contract 等 workspace，同时清理其独占的测试、构建和发布脚本；旧架构只保留 [apps/kite-cli](../../apps/kite-cli/README.md) 供源码阅读。其依赖闭包已删除，不再提供旧 library 导入、构建或普通启动。旧命令的拒绝行为和旧制品证据属于[删除前历史](https://github.com/ferqx/kite-code/tree/d5407cfe4319c5a84d530f63b1d0a0123218ad34/scripts)，不作为当前命令列表。正式和开发入口只使用上表的新架构；删除旧源码不改变 unknown、数据保护、平台或发布门禁。

`cli:dev`、`tui:dev` 和 `web:dev` 验证实际 Bun 与已构建 Service 的 SHA，通过私有 bootstrap 准入。缺资产局部失败；help/version 与严格参数拒绝先于 Profile 或 Provider I/O。开发 entry SHA 只标识所选入口，完整发行资格另行核对。

开发 CLI 的 `run/resume` 消费公开 Client；`resume` 在原 Session 输入新任务，冷接续原 Run 使用明确 recovery 命令。`--skill` 只选已配置知识，Workflow 使用明确 `--activate-skill`。首次 mutation 前保存完整原申请，回执未知只查原 ID。stdin EOF 保留原待人工作；Ctrl+C 精确取消原 work。显式 `--server` 连接所选 data root 的原共享服务，不读取本地 Service 资产。`caller list` 和 `files intents` 仍先连接服务，不是离线查询。参数和退出码见[CLI 手册](../handbook/cli/commands.md)，真实 argv 证据见[CLI owner](../../apps/cli/README.md)。

开发 TUI 的 `Ctrl+R` 选择 Session，`Ctrl+N` 创建同 Workspace 新 Session，`Ctrl+E` 选择执行详情；原未知 Command 由自动观察只读核对，`Ctrl+L` 无操作，不刷新、查询或清屏。普通 Esc 或一次 Ctrl+C 精确取消活动原工作；一秒内两次独立 Ctrl+C 沿正常退出保存草稿，原生合并批次不当双击退出。Shift+Tab 在各面板焦点下只切下一次输入的计划意图。stdin EOF、PTY 关闭和 SIGHUP 停止输入与观察；`Ctrl+Q` 或明确 SIGTERM 关闭本宿主拥有的 paired Service。当前命令与持久草稿、Files 恢复和终态等待见[命令参考](../handbook/clients/tui/reference/commands.md)及[CLI/TUI owner](../../apps/cli/README.md)。当前原 52 个真实终端旅程的完整文件证据及其余 60 个宿主文件的默认回归归[进度](../plans/unified-agent-refactor-v1-progress.md)，本机结果不取得 Linux/Windows 或完整 §35 资格。

`web:dev` 使用新只读 Gateway，不发现旧 daemon。它只接受可选 `--data-root <绝对路径>`，stdout 输出 Browser 地址。关闭浏览器结束读取；launcher EOF、Ctrl+C 或 SIGTERM 清理其所属 Service/Gateway。只读范围和资产条件见[Web owner](../../apps/web/README.md#新开发-web-宿主入口)。

## 制品与启动验证

[`ensure-web`](../../scripts/development/ensure-web.ts) 先验证两个闭合 CLI 调用，再经固定 Terminal 依次执行 `server start` 和 `web`；任一步非零即保留退出码。回归见[release tools 测试](../../tests/isolated/unified-agent/release-tools.test.ts)，显式服务操作见[生命周期](../handbook/server/lifecycle.md)。源码入口忽略安装登记；已安装标准前门可按明确 nonce 登记 Native，具体规则见[Native owner](../../apps/desktop/docs/native-release.md)。

Terminal 的构建、归档、安装和 lease 见[终端制品说明](../../apps/cli/docs/terminal-release.md)。SQLite 发布必须实际选择已审查引擎并核对 sourceId；macOS 复制明确构建依赖或 `--sqlite-library`，不安装系统依赖。未选引擎的开发源码仍 unqualified，不能用于解释或改写正式候选 WAL。

平台支持、完整默认 Shell、原生 Windows 和发行证明分别按[发布边界](../active/release-control.md)核对。当前完整默认 effectful platform 缺资格会被 formal verifier 拒绝，进程监督不能被称为操作系统沙箱。

## 修改与验证

先运行所属 workspace 的相关测试。跨包协议、持久化、授权或恢复变化再扩大到对应边界与 qualification；Web build 不能代替 TUI PTY，fixture 通过不能外推原生平台支持。测试分层和真实模型调用约束见[测试入口](../../tests/README.md)。只修改文档不默认调用真实 Provider 或外部服务。

Required quality job 运行 `bun run format:check`（Biome check），同时检查格式、imports 和启用的 lint；hook 的 staged 输入、平台与制品资格仍独立验证。失败先核对产品要求、当前合同和实际断言，不能削弱仍有效的约束。CLI 参数变化同步手册和相关测试，不提交本地 checkpoint、临时产物或密钥。

生产 TypeScript 不用 `as any` 绕过约束，也不以 `as unknown as T` 代替判别联合守卫；`catch` 未知错误先收窄。外部 SDK 必要断言限制在适配边界并说明原因，测试 mock 不扩散为生产接口。`man` 的直接提交由[本地分支守卫](../../scripts/check-protected-branch.ts)和 [Required workflow](../../.github/workflows/required.yml)限制，合并/cherry-pick 按实际守卫核对。
