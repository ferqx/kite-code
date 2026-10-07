# Native 候选、安装与独立 CLI 注册

本页负责完整 Native 物化、归档、使用锁和安装注册。构建后的候选包含实际 Electron、完整新 Terminal、main/preload/renderer 与目录/框架链接；它不从运行环境搜索 Service、Bun、CLI 或 npm。根入口已切换，整体 V1.3、签名与三平台发布仍未完成。

## 构建与安装

```sh
bun run release:build --directory /absolute/output/terminal
bun run release:build --product native --terminal /absolute/output/terminal --directory /absolute/output/native --archive /absolute/output/native.tar.gz
bun run release:verify --product native --directory /absolute/output/native
bun run release:install --product native --archive /absolute/output/native.tar.gz --sha256 <SHA256> --prefix /absolute/install/native --cli-prefix /absolute/install/terminal
bun run release:native register-cli --prefix /absolute/install/native --cli-prefix /absolute/install/terminal
bun run release:native unregister-cli --prefix /absolute/install/native
bun run release:native rollback --prefix /absolute/install/native
bun run release:native uninstall --prefix /absolute/install/native
```

目标 Terminal prefix 必须已经是同一管理工具的合法独立安装；`--cli-prefix` 可省略，明确 register-cli 也可在安装后执行。构建、归档和解包目标必须不存在。安装只接受明确归档 SHA 与 prefix，不修改 PATH、shell 配置、用户 Profile 或应用数据。当前安装实现为 POSIX；Windows 安装明确 unsupported，不能以 Windows 类型/构建通过代替安装资格。

## 完整身份与生命周期

[Native verifier](../../service/src/native-runtime-assets.ts)核 outer 的准确普通文件、目录及受限相对框架链接，并独立完整核 inner Terminal。tar 只存普通字节和封闭链接声明；拒绝 traversal、真实 tar links、重复/PAX 冲突、外部 hardlink、篡改及未声明条目，物化后重新核两层。目录中的 Electron 空 locale 也必须在准确清单内。

Node main 持 outer/inner 两个 SH，继承 Bun helper 只关闭副本，不对 shared description UNLOCK。Service 与共享 Daemon 独立保两 root 使用权。Native proof 只接受已完整核验 inner Terminal 清单中的 `service` 或 `daemon`，两种入口均固定同一包内 Bun、`native-<digest>` 与 outer manifest；CLI/Electron 入口不获得 Service 身份。verify 与 private startup proof 的原 build/entry/runtime/manifest 必须准确相等，默认 Files 保护两个实际完整 root。关窗口、关闭 Client 或父进程退出不等于全部 lease 已释放；原运行/资源确认关闭后才释放。卸载先取得所有候选的双 root EX，busy 立即拒绝，不猜 PID 或强杀服务。

卸载在原安装 EX 内先核封闭管理结构、准确候选 ID 和 outer/inner 真实目录，再按稳定顺序取得所有候选双 root EX。busy 在内容读取前拒绝；候选同时损坏且使用中时先返回 busy，释放使用权后仍完整核 manifest、文件字节和 digest，损坏不能卸载。全部 EX 持有后完整核每个原候选，删除前再次核管理结构、active/previous 与候选 ID 集合；漂移拒绝，部分取得的租约沿原 finally 释放。原登记 nonce CAS、rename/fsync、数据保留和真实卸载保持，完整验证不靠缓存。

不可变 releases、两行 active 与 previous 只控制后续启动；旧进程继续使用原候选。升级与回滚不替换数据、不恢复旧备份。Native 私有 `node:sqlite` 引擎在选 Profile/打开 UI 数据库前实测并核 manifest；Bun Worker 引擎另行选择，两者不互相冒充。

## 标准命令登记与卸载恢复

双 prefix 以固定顺序持安装 EX，0600 封闭 metadata 保存 terminalPrefix/nativePrefix/candidateId/nonce。标准独立前门在持有 Terminal SH 后复核双方原 nonce、Native active 与双 root SH，再执行 Native 内 Bun 和固定 CLI/TUI，配套 Service 同属该闭包。读取不授予其他 Profile 或任意可执行入口。坏登记、nonce 漂移或 active 漂移拒绝，不自动回退。

Native 自带 `bin/kite`、`bin/kite-tui`、`bin/kite-desktop`；独立 Terminal 前门也可选择该 Native。安装更新只更新自己仍拥有的登记，卸载以 nonce CAS 撤销，不能抹掉后来另一个 Native 的登记。独立前门仍存在时，标准命令恢复该 Terminal。若父 shell 已缓存 Native-bin-first 的路径，删除后该缓存真实返回 127；用户执行 `hash -r` 或打开新 shell 后恢复 PATH 查找。安装器无法清除父 shell 缓存，不留未经用户授权的 stub，不修改 PATH/RC。

## 真实代码升级与冷回退

[跨代码窗口验收](../../../tests/isolated/unified-agent/native-cross-version.test.ts)补充原同源码版本标记的指针测试。macOS固定旧提交 `3140fe6d37131050033c66ffd9637fe7cd967da9` 由自己的 Terminal 和 Native builder 构建，与当前代码保持相同锁文件、八 workspace 清单、补丁、Core format 1 与 Native DB7；两者 productVersion 都是 `0.1.0`，inner、Main、renderer 的实际字节及候选 ID 不同，两个原前端字节断言保持。[物化夹具](../../../tests/fixtures/unified-agent/terminal-predecessor.ts)在删除旧源码前完成旧 Native 构建，随后两个候选均归档、解包、搬迁并删除原输出。临时旧 clone 仅是验证输入，不承载当前实现或 Git 交付。

实际 installed `bin/kite-desktop` 启动默认 Main 和配对 Service，经窗口完成 A 原任务、升级 B 并产生新完整正文、冷回退 A 读取 B 正文并继续原会话，再切回 B 冷读三条原任务。升级时运行中的 A 仍持原 outer/inner，卸载 busy；四次普通退出后全部候选两层可独占。Core 和 Native 私有数据库的 inode/完整字节、原配置在指针切换与卸载时保持，回退不恢复旧备份。完整正文经过实际窗口按钮与 Main/HTTP 读取；短回答以内联全文显示，同时经 Main 完整读取边界核对。每次冷读保持原 Command/Run/Model、正文/hash/ref 与 Store 游标，Provider 不增长。持久 caller 目录保原记录，冷记录不恢复为当前进程输入绑定；回退后的新模型实际收到 B 全文。

本机有限作业已通过 1 项、374 条 Bun 断言及实际 driver 断言，三次失败与修正、准确候选和阶段完整回归归[进度](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07native-真实代码升级与冷回退)。这证明 macOS 上两个本地真实代码候选的兼容链，不是已发布 predecessor/T029、任意版本回退、远端 Provider 或 Linux/Windows 资格。生产安装和回退逻辑未修改，现有 Windows 限制保持。

## Linux 真代码升级与冷回退

同一完整跨代码文件现对macOS/Linux执行，Linux使用首次接受准确builtin SQLite3.53.2来源的原提交 `1b796e30ab0f3638767095d86d4afd374eae662a`，由该源码自己的Terminal和Native builder生成候选。Mac前驱在Linux的原来源拒绝保留；不修改旧源码、白名单、版本文字或数据库。相同依赖/基线、源码前后干净及成功删除原源码的守卫继续适用，取舍归[平台前驱决定](../../../.agents/notes/implemented/testing/2026-10-07-platform-real-code-predecessors.md)。所有平台都核实际Agent字节与inner/outer候选不同；Mac两个前端差异断言原样保留。Linux本轮实际变化为包内Agent worker，Main制品hash不同、renderer字节相同，不能据此认定renderer逻辑演进已验收。

Linux使用实际Electron dist和manifest executable路径、Node `.mjs`、准确`ps` argv/父PID，仅转发`DISPLAY`/`XAUTHORITY`。[窗口driver](../test/native-cross-version-electron.fixture.ts)四次均显式开启Chromium sandbox并核实际sandbox/contextIsolation=true、nodeIntegration=false及没有no-sandbox。原420秒整例、120秒driver、15秒窗口和上述原Store/Command/Run/Model/正文/caller/零重放/双lease/数据保留断言不变。Canonical Ubuntu Base24.04.5、Docker VM原生arm64、UID501、Bun1.4.2/Electron44.3.0/Node22.21.1/Xvfb实际整文件1pass/374条Bun断言及driver断言，actual0/171.298秒，四次窗口普通退出结束于driver80.070秒。回退后的新任务实收到352041字节B全文，最终卸载保Core/Native DB/config原字节和inode。

准确候选、失败、摘要和阶段回归归[本轮进度](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07linux-真实代码升级与冷回退)。release candidate另在macOS和Linux调用整个文件，Linux在Xvfb中执行，静态守卫拒绝平台缩减、关闭、echo、过滤或缺显示。此处为Linux arm64两个本地原始代码候选的有限兼容链，不替代已发布predecessor/T029、G1 hosted Ubuntu x64、Windows、四Auth/Vault、新signal故障窗口或全部§35/T/E；生产安装、回退和默认宿主Shell语义没有修改。

## Linux arm64 安装生命周期

[原完整安装文件](../../../tests/isolated/unified-agent/native-install-lifecycle.test.ts)现对 macOS/Linux 执行，临时目录使用平台 `tmpdir()`，Electron 发行目录按实际平台定位，Node driver 使用明确 `.mjs`。Linux 只转发显示所需 `DISPLAY`/`XAUTHORITY`；`ps` 使用实际 executable argv 列，仍核准确 Main 父 PID。原 120 秒整例、45 秒 driver、10 秒窗口等待及全部业务/双锁/保数据断言保持。

测试 driver 的正常退出由 Playwright `close()` 发起一次 `app.quit()` 并等待真实 Main 退出，控制用 HTTP 请求明确关闭连接；不调用 `process.exit()` 代替资源清理。2026-10-08 原安装用例在本机以 driver36.428秒自然退出、计时器未触发通过。先前完整默认曾在原45秒窗口失败，耗时包含完整安装校验；定向通过与这次夹具清理不单独证明并发默认图或每个平台通过，当前完整结果归[进度证据](../../../docs/plans/unified-agent-refactor-v1-progress.md)。

[实际 driver](../../../tests/fixtures/unified-agent/native-install-electron.ts)明确 `chromiumSandbox:true`，两次窗口均核全局没有 `--no-sandbox`，且实际 BrowserWindow 的 sandbox/contextIsolation 为 true、nodeIntegration 为 false。Playwright 的 Linux 默认会关闭 Chromium sandbox，因此不能沿默认值取得资格。自有容器使用 [Playwright 官方 seccomp allowlist](https://playwright.dev/docs/docker#crawling-and-scraping)的 namespace 支持，保留 no-new-privileges、无 privileged/额外 capability；不向产品或默认 Shell 注入该容器配置。

当前有限实测为 Canonical Ubuntu Base 24.04.5、Docker VM 原生 aarch64、UID501、Bun1.4.2、Electron44.3.0、Node driver22.21.1、Xvfb。完整归档/解包/搬迁和删除原输出后，实际 installed `bin/kite-desktop` 经默认 Main/renderer/Service完成一次模型任务、冷读、同源码版本指针升级/回滚、正常退出与双锁强杀窗口、最终卸载保 Core/Native DB/config 原字节。[Store写锁等待修复](../../../packages/agent/src/storage/README.md#写锁的有界等待)后重新生成的当前候选再次通过，Provider 恰1，1pass/25条Bun断言，71.851秒、driver26.455秒；准确 manifest 分别实测独立 builtin `node:sqlite`3.53.4 和 `bun:sqlite`3.53.2。首次76.692秒的原证据另保。它不是 Linux 真实跨代码/已发布 predecessor、Vault、全部 Native 业务、Windows 或 G1 原生 Ubuntu x64 CI 资格。

此前 x64 用户空间经 Rosetta 仿真的三轮实际失败分别为旧 Node/ESM driver、45秒 driver、临时55秒driver仍撞原120秒整例。失败证据保留，55秒更改已撤销，没有用仿真失败换取原预算放宽。补齐 git 前的 arm64 设置失败也保留。准确输入、原始日志和正常 owned 收尾见[进度](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07linux-native-安装生命周期)。release-candidate 的 Linux 步骤执行整个原文件，Required unit 在 Xvfb 内执行整个默认图；CI 守卫拒绝移除/错平台/echo/过滤或静默关闭显示入口。定义不等于 hosted 通过。

## 验证与限制

[默认宿主 Shell 生命周期](../test/isolated/native-shell-lifecycle-bundle.test.ts)在 macOS 搬迁、删除构建源的完整候选核页面实际新建后台 Job、完整保存输出、准确停止、Main/Service SIGKILL 后本次 coalition 全树消失及两次冷读零重放；候选 outer/inner EX 在最终全部普通/异常退出后可取得。它使用生产默认 Service/宿主 Shell；Service 崩溃后的原未完成状态不改写为停止成功。该窗口运行 relocated candidate，不补齐 installed 故障/升级样本或 G1，准确结果归[进度](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08native-默认宿主-shell-完整用户路径)。

[真实 Native archive/install/lifecycle](../../../tests/isolated/unified-agent/native-install-lifecycle.test.ts)在源码树外删除原候选后启动实际 Electron Main 与所属 Service，验证原数据/cold 读取、升级旧进程固定、双锁强杀窗口、回滚与卸载。[注册验收](../../../tests/isolated/unified-agent/cli-registration-lifecycle.test.ts)核两种 PATH 与真正 80×24 TUI，公共 Store 核三条 Run completed，实际 Provider 3；每次运行中卸载 busy 并保持登记，卸载后原查询、数据库/config/caller bytes 和 cursor 不变。[Files 保护](../../../tests/isolated/unified-agent/native-runtime-protection.test.ts)核 Workspace 中实际 outer/inner 读写保护与邻接正常效果。

[实际安装 stdin](../../../tests/isolated/unified-agent/native-stdin.test.ts)删除构建源后使用 Native 自带 `bin/kite` 启动共享 Daemon，核原问题的空白拒绝与 EOF 等待、新 CLI 进程沿原 Work 回答一次、完整 Provider/历史语义及重复零新 Run/Answer。启动 CLI 退出和工作完成后，Daemon 仍独立阻止卸载；实际 stop/status absent 后才卸载。该证据不包含 Daemon 冷重启或 Electron 窗口。

[有限卸载反例](../../../tests/isolated/unified-agent/native-install.test.ts)使用真实 inner SH 与坏 manifest 验证 busy 优先、失败后的 outer EX 可重新取得、空闲后的完整性拒绝及准确 active/内容保留；两层目录 alias 也拒绝。有限夹具只证明锁与格式合同，真实窗口沿原安装生命周期任务、45 秒 driver 期限与准确退出断言另行运行。

macOS arm64 保原 Bun/Electron、普通退出及已运行故障窗口资格；Linux arm64 仅取得上述完整安装文件的有限资格。纯 version smoke 只核 executable/引擎，`mainLifecycleQualified:false`，不能当窗口验收。新 signal fault 窗口、已发布 predecessor、Linux x64/Windows Native 生命周期、签名/公证/发布者认证及完整 T001—T114/E01—E14 仍需各自实际证据。当前归档 SHA/manifest 只提供完整性。

完整闭包、双 prefix nonce CAS 和父 shell cache 的持久理由见[Native 登记决定](../../../.agents/notes/implemented/architecture/2026-10-04-native-complete-closure-and-cli-registration.md)；Node/Bun 引擎独立测量见[SQLite 选择决定](../../../.agents/notes/implemented/architecture/2026-10-04-selected-sqlite-engine-and-worker-identity.md)。Note 状态不能替代上述平台和发布证据。
