# Native 候选、安装与独立 CLI 注册

本页负责 Native 候选、归档、使用锁和安装注册。候选包含实际 Electron、main/preload/renderer、配套 Service 和固定的包内 Node。macOS arm64 和 Windows x64 默认生成桌面专用候选，`--terminal` 可显式嵌入已验证的完整 Terminal。Linux 继续使用完整 Terminal。整体 V1.3、签名与三平台发布仍未完成。

本轮会话 PDF 能力的 parser／Canvas／字体／CMap／WASM 由内含 Terminal 的同次依赖闭包交付，准确版本与剩余资格见[Terminal 构建说明](../../cli/docs/terminal-release.md#构建与操作)。隔离浏览器里的 Native 页面和 Main reader 通过不等于完整 Electron 制品或各平台的原生解析资产通过；旧窗口／安装证据不自动覆盖新增闭包。

轨迹只读窗口另有固定 `trajectory.html`／renderer／preload 构建入口，仅暴露本地 `trajectoryFiles`，冷开位于 Profile／Runtime 初始化之前，生产 CSP 禁止联网。内含 Terminal 同次物化独立 Trace engine／QuickJS WASM 和可信 OTel runner／官方依赖与 notices；缺资产只关闭相应 Trace 能力，原资源关闭未知仍阻止虚报清理成功。本轮源码 Native 过程及 Terminal 候选包外闭包证据归 [Desktop owner](../README.md#执行轨迹离线窗口与-trace-设置)和 [Trace owner](../../service/src/trace-extensions/README.md)，不继承旧安装制品或其他平台资格。

本地图片工具另新增固定处理程序／摘要及Sharp0.35.5平台native闭包，同样由内含Terminal依赖物化。当前Agent构建与源码树外离线读取已核实，实际范围见[Files owner](../../../packages/agent/src/tools/files/README.md#当前验证与性能)；本轮没有构建或安装包含这些新资产的完整Native候选，旧资格不自动覆盖。

Windows 构建预检和运行清单均要求 Chromium 的 `chrome_100_percent.pak`、`chrome_200_percent.pak`、`resources.pak` 为非空普通资源文件，仍核完整递归库存与每字节摘要。只有 Electron Node/SQLite 通过不能证明窗口资源完整。本机原已安装 Electron 44.3.0 分发后来发现缺两份 scale pak；原字节一致性证据只证明当时副本与该输入相同。新的隔离输入从缓存原 ZIP 解出，SHA256 `26bf9a617d58d81772b3d68305d59ee48272969c15083c06db634a77358a8d9d` 与锁定 npm checksums 和[官方发布清单](https://github.com/electron/electron/releases/download/v44.3.0/SHASUMS256.txt)一致，不修改原安装。缺资源反例归[归档/构建合同](../../../tests/isolated/unified-agent/native-archive.test.ts)；真实窗口和维护仍须分别通过原 caller。

当前 renderer 沿原桌面的 Vite/React/Tailwind 管线编译复用页面，CSS 与 Geist 字体是候选内的实际文件；Vite 输出保留 Main/preload/helper 的共同目录。新增 UI exports 在 workspace build 中产生实际 desktop/index.js 与 style.css，候选继续逐项核完整递归 manifest。macOS 源码外窗口范围与剩余迁移见[Desktop owner](../README.md#复用原桌面展示层)和[本片进度](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08复用原-pc-桌面展示层)，不替代完整 installed 或三平台资格。

[Native builder](../scripts/build-native.ts)的非development renderer固定使用生产React与JSX转换：`esbuild.jsxDev=false` 和 `process.env.NODE_ENV=production`，不随构建调用进程的 `NODE_ENV=test` 等环境切换。该规则同时适用于普通与显式测试诊断候选，诊断常量仍按独立构建输入封存，开发服务器不改。实际renderer字节的开发栈守卫及本机窗口范围归[Desktop owner](../README.md)和[构建模式决定](../../../.agents/notes/implemented/bug-fix/2026-10-21-native-renderer-production-build.md)；不以定向窗口通过替代完整manifest、安装或三平台门禁。

inner Terminal 的共享 UI 构建内联已声明的普通 JS 依赖，保留原 exports、React/React DOM peer、CSS 与准确许可；其余动态资源与原生资产仍按原解析图复制，边界归[Terminal owner](../../cli/docs/terminal-release.md#制品闭包与身份)和[闭包成本决定](../../../.agents/notes/implemented/bug-fix/2026-10-17-windows-bundle-admission-cost.md)。outer、inner 和每次启动的全部文件验证保持；同一原 pin 只能在本进程复用完整核验，不跨进程授予准入。启动收益须由原正式窗口及完整默认结果核实，旧[图标收束证据](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09普通制品图标依赖收束)只覆盖当时范围。

Windows 显式安装 caller 使用原安装器的受保护复制接口准备未发布 A/B，保全部 verifier 和原 120 秒基本／180 秒维护期限。UIA snapshot 在原进程身份核对后允许“尚无窗口／Document”的空观察，只有期限内实际出现的完整文本才通过；异步输入只写一次并在同一原动作截止前核完整回读。原 45 秒驱动、10 秒动作、多窗口拒绝、自然退出和原 Job 回收保持，理由见[发布夹具决定](../../../.agents/notes/implemented/testing/2026-10-17-windows-release-contracts.md)。隔离 renderer／HWND 诊断只存在于私有诊断制品，普通 dev／prod 不含该入口。

Windows Main 保初始完整内容／语义验证，再由 [Node-API owner](../native/windows-access/README.md)独立取得全部原文件并核完整 SHA、manifest ID、闭合库存和两跳证书；后续复用该 Main 的 genuine owner，每次核原对象、有效 ACL、准确库存和双 SH，不再重复两次无 owner 的 Node 全扫描。持续 pin 拒绝字节改写／删除，目录新增项由重新枚举拒绝；子 Service 仍独立完整准入，不继承父 owner 的权利。未关闭 owner、close unknown 和借用依赖仍按[原对象决定](../../../.agents/notes/implemented/bug-fix/2026-10-17-windows-original-object-sharing.md)处理。

## 构建与安装

准备 Node 构建输入后，macOS arm64 和 Windows x64 执行 `bun run release:build --product native` 即可独立构建桌面候选。Windows 使用已准备的 x64 MSVC 和满足现有 ACL 准入的 Node、Bun、Electron 与输出目录。macOS 用 `bun run desktop` 启动默认候选，Windows 使用已安装的桌面前门。Linux 先执行 `bun run release:build` 准备 `dist/unified-terminal`，再构建 Native 并启动。启动核对两层完整性和使用权。日常开发使用 `bun run build` 后 `bun run desktop:dev`，由独立 development profile 承载源码调整。

CLI/TUI 由 `bun run release:build` 构建的独立 Terminal 提供。下面的组合包示例用 `--terminal` 显式选择完整 Terminal，供组合安装和 `register-cli` 使用。

macOS arm64 完整 Native 的 Node ZIP 路径使用 [官方 Node 26.13.1 darwin-arm64 归档](https://nodejs.org/dist/v26.13.1/node-v26.13.1-darwin-arm64.tar.xz)。构建器核固定 SHA-256，取 Node 可执行文件和许可证进入内含 Terminal，头文件只用于构建。Service、Terminal、安装校验和维护执行使用同候选的 Node，Electron Main 使用 Electron 自带 Node。Service 的 SQLite 由 Node-API 加载原已审核的动态库，清单记录实测引擎身份和完整文件。配套 stdin EOF、Profile／制品锁和 Terminal 登记的原对象契约沿用。取舍和本机验收见 [随包 Node 决定](../../../.agents/notes/implemented/architecture/2026-11-12-bundled-node-native-runtime.md)。

```sh
bun run prepare:node-inputs
bun run release:build --directory /absolute/output/terminal --node-distribution /absolute/input/node-v26.13.1-darwin-arm64.tar.xz
bun run release:build --product native --terminal /absolute/output/terminal --directory /absolute/output/Kite-Native --archive /absolute/output/Kite-Native.zip
```

核对 ZIP 的 `.sha256` 后用 macOS 解压，完整保留包内链接和权限。在解压目录执行 `terminal/entrypoints/kite-install.command verify` 校验候选，再执行安装。用户端使用随包运行时。

```sh
./terminal/entrypoints/kite-install.command install --prefix /absolute/install/kite
/absolute/install/kite/bin/kite-desktop
/absolute/install/kite/bin/kite-maintenance verify
/absolute/install/kite/bin/kite-maintenance rollback
/absolute/install/kite/bin/kite-maintenance uninstall
```

安装同一前缀的新版会保留前一个完整候选。回滚后的旧 Bun 候选使用旧版自己的运行时，Node 维护入口可由前一份 Node 候选提供。若已登记独立 Terminal，先更新其候选至支持 Node 清单的版本，Native 安装在发布选择前验证该条件。Windows／Linux 的构建和安装入口见下文。

2026-11-13 本机 [完整 Native 安装回归](../../../tests/isolated/unified-agent/native-install-lifecycle.test.ts)使用实际 Electron 与包内 Node，归档搬迁后完成安装、运行中升级、正常退出和冷启动。首次模型回复只发出一次，第二窗口读回原回复。随后验证 Main 被杀而 Service 存活时双使用锁继续阻止卸载，原 Service 退出后才允许回滚和卸载。会话及设置保留；这是同源码候选切换，旧 Bun→Node 的实测范围见下方 DMG。

缺外层路径或内嵌运行时会返回 `native_bundle_unavailable` 和准备命令，已取得的锁沿原顺序释放。

macOS arm64 的 Electron 仍固定44.3.0；[构建准备](../scripts/macos-electron-runtime.ts)只接受完整原始Framework SHA与封闭分发，在新候选的独立 `electron` 副本内应用[resize补丁](../patches/electron-44.3.0-macos-resize.patch)，重新进行 ad-hoc 签名及校验，再执行SQLite探针、Main构建和完整manifest。两处指令及签名以外的payload、源分发与副本独立性均复核；重新签名产生的CodeResources与最终Framework字节进入原清单，不跳过任何文件。开发入口也准备每次专属副本；不修改 `node_modules` 或已存在的不可变候选。

[Main准入](../electron/macos-electron-resize.ts)在 `app.whenReady` 前核实际加载Framework路径、构建时摘要、完整已审payload和两处指令，随后启用配套 `CATransactionV2`；禁用冲突、未知原始字节、半补丁或错误加载路径均拒绝。Windows、Linux及macOS非arm64沿原链路；通用app-only测试构建没有配对证明时不启用该feature。普通启动、归档、安装及回退不临时修补制品，旧候选须重新构建才包含本次优化。该同版本定点修正不提供正式签名、公证、其他引擎字节或跨平台发行资格，当前像素与集成测试范围归[Desktop owner](../README.md#固定-renderer-布局收敛2026-11-02)。

```sh
bun run release:build --directory /absolute/output/terminal
bun run release:build --product native --terminal /absolute/output/terminal --directory /absolute/output/native --archive /absolute/output/native.tar.zst
bun run release:verify --product native --directory /absolute/output/native
bun run release:install --product native --archive /absolute/output/native.tar.zst --sha256 <SHA256> --prefix /absolute/install/native --cli-prefix /absolute/install/terminal
bun run release:native register-cli --prefix /absolute/install/native --cli-prefix /absolute/install/terminal
bun run release:native unregister-cli --prefix /absolute/install/native
bun run release:native rollback --prefix /absolute/install/native
bun run release:native uninstall --prefix /absolute/install/native
```

`--cli-prefix` 仅用于组合包，目标必须已经是同一管理工具的合法独立 Terminal 安装。组合包安装后也可明确执行 `register-cli`。构建、归档和解包目标必须不存在。安装使用明确的归档 SHA 与 prefix，用户 Profile 和应用数据保存在安装目录外。Windows x64 的原生验证范围见下节。

`.tar.zst` 与 `.tar.gz` 都使用[同一归档校验和安装入口](../../cli/docs/terminal-release.md#制品闭包与身份)。内含 Terminal 按目标交付原生依赖。

### macOS DMG

在 Apple Silicon Mac 上按[本地开发](../../../docs/development/local-development.md)准备 Node、Bun、Electron 与 Xcode 工具链，先运行 `bun run prepare:node-inputs`，再执行 `bun run release:macos-dmg`。构建读取 [Node 26.13.1 官方 macOS arm64 归档](https://nodejs.org/dist/v26.13.1/node-v26.13.1-darwin-arm64.tar.xz)，默认放在 `.cache/release-node-v26.13.1/node-v26.13.1-darwin-arm64.tar.xz`，也可用 `--node-distribution <归档>` 指定。构建先核对固定 SHA-256，再从归档取 Node、许可证和编译头文件。默认在 `dist/macos-dmg/` 下创建带时间戳的目录，输出 `KiteDesktop-arm64.dmg` 及 SHA-256 文件，也可指定 `--directory <新目录>`。从源码构建时可用 `--electron <原始 Electron 分发目录>` 固定输入。要分开构建和封装，先运行 `bun run release:build --product native --desktop-only true --node-distribution <归档> --directory <候选目录>`，再传 `--native <候选目录>`；封装只接受 macOS 桌面专用 Node 候选。

Mac App Store 之外的分发可以使用钥匙串中的 Developer ID Application 证书及私钥和已有 `notarytool` profile。给同一构建命令传入 `--signing-identity <证书 SHA-1>` 和 `--notary-profile <钥匙串 profile 名称>`。签名制品从源码构建。Node-API 绑定先签名，再写入依赖该绑定的 Worker；其余暂存 Mach-O 在生成各级清单前签名。Electron 在应用 resize 修正后签署并重新核对 Framework 摘要。构建最后签署 `.app` 和 DMG，取得 Apple 的 `Accepted` 后附加公证票据，校验票据和 Gatekeeper，再生成最终文件摘要。最终签名制品仍需实测 Finder 生命周期。公开发行门禁见[发布边界](../../../docs/active/release-control.md)。

映像的 Finder 窗口并排显示 `Kite Desktop.app` 和指向 `/Applications` 的快捷方式。桌面 Main 由 Electron 启动，配套 Service 由应用内的 `terminal/runtime/node` 启动。工作区代码和第三方 JS 通过 `terminal/code` 的私有模块映射加载。Node-API 绑定、审核过的 SQLite 动态库、辅助程序、字体、CMap 和 WASM 随各自的消费方打包。制品不含 Bun、`node_modules`、CLI/TUI 或独立 Terminal Web 入口。构建从包内 Mach-O 的 arm64 部署目标计算 `LSMinimumSystemVersion`。启动器从 `Contents/Resources/native` 启动包内 Electron，Native 启动继续核对候选完整性和使用锁。由同一 macOS 用户安装和运行，运行时复用包内预先创建的使用锁文件。

退出 Kite Desktop 后通过 Finder 替换旧应用或将应用移到废纸篓。回滚时从原 DMG 复制旧应用，旧应用使用自己随包带的运行时。Profile `~/.kite-code/unified-agent`、Electron 用户数据及工作区路径位于应用包外。Finder 负责文件操作，应用使用锁仍由运行时管理。曾安装独立安装器预览版的用户可通过原 DMG 卸载后再拖入新应用。用户操作见 [桌面手册](../../../docs/handbook/clients/desktop/README.md#在-macos-上安装更新和卸载)。

2026-11-12，前一代 Bun 桌面专用 DMG 在 Apple Silicon、macOS 27.2.1 验证了从旧完整 DMG 替换、冷读原会话无重放、独立安装和保数据卸载。该次使用系统 `/Applications` 和隔离 Profile，记录在 `dist/macos-desktop-only/evidence/macos-dmg-n6jq48/report.json`，属于前一代制品。

同日的 Node 候选 `4feb1e3ef49034b8cde0d659d880c2e27bdd11402765a4351b790237ecb68e95` 通过 [Finder 实机验收](../../../tests/fixtures/unified-agent/macos-dmg.qualification.ts)：在私有 Applications 目录安装 Bun 版、替换为 Node 版、回滚至同一 Bun 候选、移到废纸篓，再装回 Node 版并卸载。四次启动均观察加载至就绪、同一会话和回复仅显示一次、应用和对应的包内 Service 正常退出；模型请求共一次。替换与卸载前后，数据库、配置及工作区见证文件的摘要和文件身份一致。另用空白 HOME 启动 Node 版并打开项目选择器。窗口验证使用仅含系统目录的 PATH，保留 Chromium 沙箱并核对 Service 可执行文件路径；独立 Service 探测还禁止执行宿主 Node/Bun 和读取构建目录，核实包内 SQLite 3.51.3、网页解析依赖及 stdin EOF 收尾。最低系统版本为 macOS 15.0。本机证据在 `dist/macos-node-dmg-node26.DExaYd/evidence/`。

后续真实 OpenAI Responses 请求在该候选中收到完整输出后，SQLite 制品登记因 Node 适配器缺少 `Database.filename` 而失败。修复保留构造时传入的数据库路径，[离线回归](../../../tests/fixtures/unified-agent/macos-dmg-model-output.fixture.mjs)用随包 Node 验证输出分段、私有续接状态和只读重开。

重建的候选 `3cba7169fdc08219a31d237effd1ba55ea19f8a240a1323a55b401a2538ed64a` 在同一本机通过 Finder 生命周期。通过本机回环转发复用钥匙串里的现有 OpenAI 凭据，隔离桌面会话用 `gpt-6-luna`、`high` 完成一次真实 Responses 请求。窗口显示最终回复，数据库保存的用量与 OpenAI 返回一致。冷启动与回滚后的 Bun 版读取同一会话和回复，保留暗色主题和高档设置。回滚和移到废纸篓前后，数据库、设置及工作区文件的摘要一致。本机证据在 `dist/macos-node-dmg-luna.FuZIqw/evidence/`。

包内 Node 通过私有模块映射动态载入钥匙串的 CommonJS 包。[凭据后端](../../../packages/agent/src/config/os-credentials.ts)同时接纳命名导出和默认导出中的 `AsyncEntry`。[随包探测](../../../tests/fixtures/unified-agent/macos-dmg-model-output.fixture.mjs)用随机、未登记的账户执行只读查询，核实不存在的凭据返回空结果。

候选 `bdc43fd82976c1d4a7f855ca276e2207f9cdfab0ee5cee47b7adc6bc09efb803` 在本机通过 Finder 生命周期及随包只读查询。本机用 Finder 从 Bun 应用换到 Node 版后，安装该候选，在实际 `/Applications` 安装及原用户配置上，经现有系统钥匙串凭据向配置的 OpenAI endpoint 发送一次 `gpt-6-luna` Responses 请求，思考档位为 `high`。窗口显示原输入和完整回复各一次，SQLite 核实一个成功模型执行并保存实际用量。替换时 Profile 和设置摘要一致，验收后恢复原模型启用状态。证据在 `dist/macos-node-dmg-auth.Wei8d5/evidence/`。

2026-11-13，包含[模型选择器布局修复](../src/native-model-picker.tsx)的候选 `8dbbd85021ecabfad7c6079d9d64f97a401d2618610b8989b923d872ebd1750e` 在 macOS arm64 通过镜像校验。沿[隔离 Finder 夹具](../../../tests/fixtures/unified-agent/macos-dmg.qualification.ts)实测旧 Bun 版升级、回滚、首次安装、窗口启动与保数据卸载；全程用独立 HOME 和 Profile、固定本地模型，未替换 `/Applications` 中的应用。证据在 `dist/model-picker-dmg.1bJxul/evidence/macos-dmg-N99PWY/`；选模的逐帧证据见 [Desktop owner](../README.md)。

同日，使用 Bun 1.4.4 打包的候选 `41a0c775e18e3b7778a9ca2ca71461975e333b75df33a9f647a2c8cf9fc379af` 在本机通过同一 Finder 夹具和镜像校验。系统 PATH 中没有 Node 或 Bun，更新后 Service 由包内 Node 26.13.1 启动。旧版升级、回滚、移到废纸篓、安装新版和再次卸载均保留原会话及设置。两次本地测试模型请求各保存一份回复，冷读不重发。证据在 `.cache/bun-build-dmg-final.WDoeTs/finder-evidence/macos-dmg-tsAdwL/report.json`。

切回 Bun 1.4.4 冻结安装后，同一 Finder 夹具和镜像校验在候选 `0235a8007f24bb2ef1c418e68384963cd03dd9f96c6786b4e55d5dc5dc5e4cd5` 上通过。隔离安装目录覆盖首次安装、旧 Bun 版升级、回滚和卸载。核对包内 Node、原会话与设置、两次本地模型执行及各自的持久回复。证据在 `.cache/bun-pm-dmg-final.10Oif7/finder-evidence/macos-dmg-WdJv1F/report.json`。

回复位置修复后的本机候选 `5beb3e54641745633414c23e96ab1832dc12270f9afdfd1135f0644e62637b0a` 再次通过 Finder 替换。冷重开上一轮真实模型会话时只显示一份原输入和回复，没有旧拒绝提示或新的模型执行；隔离窗口验证“无认证”在对应输入下方，重开保持位置且没有 Provider 请求。安装与实际窗口证据在 `dist/macos-node-dmg-final.IgRkpW/evidence/`。

2026-11-13，在独立 HOME 和 Finder 安装目录，用候选 `8596852f6d20f9224e2c8dab1d3a2712dc272bad9479a202b85006718a767d39` 验证旧 Bun DMG 升级到 Node DMG、回滚、移到废纸篓，以及 Node 版首次安装、启动和卸载。核对了实际 Electron 与随包 Service 进程、回环模型响应、冷读和 Profile、设置、模型偏好及工作区文件摘要。记录在 `dist/node-service-agent-dmg-final.qtXUM7/evidence/macos-dmg-Umh7c9/report.json`。

同日，统一 Node 工具链且不再携带旧 Trace 启动配置的候选 `2de0923f996199a8960a16c421a2d3fa3864e97f30eddbc15fba774ec550cc24` 通过相同 Finder 流程。新版窗口在原 Store／会话中发起第二轮本地测试模型请求，原两轮各有唯一持久记录，最终卸载保留记录、配置和工作区文件。独立 Applications 目录与 Profile 未触及日常安装或配置。本机证据为 `.cache/node-only-final.wE8Cla/finder-evidence/macos-dmg-3wxEh2/report.json`。

本机 ad-hoc 演练为无 Team ID 的测试库临时关闭库校验，Developer ID 路径保留库校验。Developer ID、公证、最终签名制品复验和公开发行资格沿 [发布边界](../../../docs/active/release-control.md) 单独核验。取舍见 [Finder 安装](../../../.agents/notes/implemented/feature/2026-11-12-macos-drag-dmg.md)和 [DMG 随包 Node](../../../.agents/notes/implemented/architecture/2026-11-12-macos-desktop-dmg-node.md)。

Developer ID 路径给配套 Service 的 Node 使用固定签名标识 `com.kitecode.desktop.service-runtime`。同一签名身份升级时保留钥匙串对该运行时的识别。旧读取程序的权限由用户在连接设置中显式确认，常规模型调用只做无交互读取。[模型凭据决定](../../../.agents/notes/implemented/architecture/2026-11-13-encrypted-model-credentials.md)

2026-11-13，含统一模型凭据的候选 `b7513ab31b93055577b67d894d71d529ed6d4a6a3cc674c3af89f7bf8849874d` 在隔离 macOS HOME 下通过相同 Finder 流程。Native 构建选用 JSONC 解析器的 ESM 入口，将编辑和扫描模块打入应用。系统 PATH 无 Node 和 Bun，窗口验证两次本地模型请求、冷读与保数据卸载。证据在 `.cache/model-vault-dmg-verified.B7PfuD/finder-evidence/macos-dmg-yCjYfc/report.json`。

同日，评审修复后的候选 `44e6c5dc` 用 Bun 构建，Finder 夹具以仅含 `/usr/bin:/bin` 的 PATH 实测旧 Bun 版安装、升级至包内 Node 26.13.1、回滚、移到废纸篓、重新安装及卸载。夹具等待系统实际显示主窗口，核对两轮回环模型回复各持久化一次、原 Store／会话和设置保留。镜像 SHA-256 为 `81ff4182984a9bcbebceae58e76e7627081e12f75b030a5a0338189ea326e735`。本次使用私有 Applications 目录和 Profile。

Windows x64 离线 `.exe` 接受 `--desktop-only true` 生成的 Native 归档。构建包含桌面 Main、renderer 和本地服务。服务的工作区产物与第三方 JS 位于 `terminal/code`，通过相对路径加载。原生绑定、辅助程序、PDF 字体和 WASM 等资源单独保留。安装包的生产入口拒绝含 `node_modules` 的归档。旧桌面包的清单仍可核验，以便升级和卸载。新归档和安装后的程序树各含一份 `node.exe`。C 前门核对并持有包内 Node、原生插件与 ESM 校验脚本，再启动两跳证书校验。配套服务使用同一 Node。

构建器把保留的模块导入和 `require` 改写为 Node 使用的 `code/package.json` 私有映射。映射目标是制品中的相对路径，拆分文件可共享同一个模块。[搬迁回归](../../../tests/isolated/unified-agent/windows-desktop-runtime.test.ts)验证从仓库外加载共享模块；新 Node 版尚无 Windows 实机安装证据。

Windows x64 桌面制品由同次构建封装 Service 和 Runner V7。包内 Shell 清单固定原生 Runner 及 Git Bash 所需辅助文件。Git Bash 使用本机完整安装，回退使用 Windows 自带的 PowerShell 5.1。两条路径的进程边界、权限和证据见 [Windows Shell 沙箱](../../../docs/active/windows-shell-sandbox.md)。

安装时，候选在目标盘的私有暂存目录解包和验证，通过同卷移动发布。已有相同候选时复核并复用。[Win32 安装窗口](../../../scripts/release/windows-setup/location-dialog.cc)用准备、校验、写入、移除和收尾对应的进度区间显示总进度。区间内由实际计数推进，字节、文件或条目数单独显示。等待或重试保留已达到的进度。应用登记、快捷方式及清理处理完毕后，直接切换到结果页，隐藏百分比和进度条。构建需要 MSVC x64 Build Tools、Git for Windows、Node、Bun 和 [Zstandard 1.5.7 发布源归档](https://github.com/facebook/zstd/releases/tag/v1.5.7)。构建脚本核对解码器源归档摘要。

在仓库根目录运行以下命令，构建桌面专用制品，核对清单并生成 Windows x64 离线安装包。

```powershell
bun run prepare:node-inputs
bun run release:windows-setup
```

命令从已安装的 MSVC x64 Build Tools 准备编译环境，从 `.cache/desktop-win-x64-setup/zstd-1.5.7.tar.gz` 读取 Zstandard 源归档，并在 `dist/windows-setup/` 下自动创建带时间戳的新目录，输出 `KiteDesktopSetup.exe`、SHA-256 文件和 Native 归档。

封装器使用运行命令的 Node，也可用 `--node <私有 node.exe>` 明确指定。包内 Node 来自 `prepare:node-inputs` 准备的官方归档。Electron 优先读取 `.cache/desktop-win-x64-setup/inputs/electron-<固定版本>/dist`，缺少时使用项目安装的 Electron。选中的输入仍须通过原制品权限和完整性校验。

需要分别运行构建和安装器步骤时，使用以下命令。

```powershell
bun run release:build --product native --desktop-only true --directory <native-directory> --archive <native.tar.zst>
.\scripts\release\windows-setup\build.ps1 -Archive <native.tar.zst> -Sha256 <SHA256> -ZstdArchive <zstd-1.5.7.tar.gz> -OutFile <KiteDesktopSetup.exe>
```

安装窗口通过当前用户的安装登记和旧开始菜单快捷方式识别已安装位置。发现已有安装时沿用所选目录。带 `client` 子目录的旧安装和桌面专用安装在核实旧程序树后准备新版，确认新版发布后移除旧树。更早直接安装在所选目录的版本先验证新归档，再清理旧文件并创建新版目录。新安装支持编辑路径或浏览磁盘。目录选择沿[原目录决定](../../../.agents/notes/implemented/feature/2026-11-11-windows-setup-location.md)，当前布局归[桌面专用包决定](../../../.agents/notes/implemented/feature/2026-11-12-windows-desktop-only-installer.md)。

安装和更新完成后，安装器为当前用户登记 Kite Desktop。小型 GUI 启动器位于所选目录的 `Kite Desktop.exe`，开始菜单和可选的桌面快捷方式都指向它。启动器以无窗口方式调用已安装的前门，Electron 启动时清理继承的 Crashpad 和日志环境。卸载按摘要短期暂存已安装的 Node 和原生插件；旧版仍识别随包 Bun。以同一批原文件句柄检查摘要和移除程序文件。占用持续时，界面提供退出应用提示和重试／取消。进程只向安装器交付固定阶段、成功回执和错误码。仅卸载所有者可清理旧版已识别的 Crashpad 注册日志。卸载移除快捷方式和 Windows 登记，Profile 保留在安装目录外。持久取舍见[桌面专用包决定](../../../.agents/notes/implemented/feature/2026-11-12-windows-desktop-only-installer.md)。

显示卸载完成前，卸载器将原启动器移到同卷私有目录并启动清理进程。清理进程在卸载窗口关闭、原进程退出后移除该文件。原路径可用于下一次安装。

首次安装按欢迎、安装位置、快捷方式、进度和完成推进。在选项页之间返回时保留路径与勾选状态，目录使用失败时返回安装位置。目录页的应用文件大小来自候选归档，可用空间取自目标目录或最近的现有上级目录。更新直接显示确认页，以文本展示检测到的安装目录。同名 Windows 登记与旧版可识别安装均沿原目录更新。更新仅调整仍存在的 Kite 桌面快捷方式，已移除的快捷方式保持缺失。安装和更新完成后，只有勾选「立即打开 Kite」并点击「完成」才启动桌面应用。

2026-11-12 Windows x64 隔离验证包使用独立安装登记。验证日志记录了安装解包、校验 645 个文件、写入和发布，以及文件占用时等待、释放后重新核验并移除 717 个条目。随后在原路径重新安装并卸载，验证登记已清理。桌面锁屏期间只核对了安装完成页的控件文本，仍需在解锁后观察窗口的完整阶段切换。

2026-11-13 在 Windows x64 使用独立登记实跑首装、原目录更新和卸载。核对了首装选项、更新确认、更新取消、安装与卸载进度和完成页。更新后开始菜单入口可查，手动移除的桌面快捷方式保持缺失。截图验证包在实际计数出现时短暂停留，拍到校验 189 / 645 个文件，以及应用文件被占用、释放后移除 717 / 717 个条目。卸载完成后核对了独立登记、快捷方式和启动器的移除。本机截图在 `dist/windows-setup-ui-20261113/screenshots`。

同日换用分步向导后，另核对欢迎、安装位置、快捷方式、返回保留选择、更新确认与取消。隔离制品实跑首装和卸载，截图捕获校验 181 / 645 个文件与移除 439 / 717 个条目，随后均进入各自的完成页。新布局的本机截图在 `dist/windows-setup-wizard-20261113/screenshots`。

进度条改为按当前操作计量后，在 Windows x64 隔离制品重跑首装和卸载。校验 181 / 645、写入 41 / 647、移除 480 / 717 时的条形分别约为 28%、6%、67%。校验计数来自清单中的文件，写入计数另含两份清单文件，文件经刷盘和关闭才计入。持有共享使用权时显示等待，释放后恢复并进入卸载完成页。截图位于 `dist/windows-setup-progress-20261113/screenshots`，隔离截图包延长了真实进度的停留时间。

改用总进度后，同日在 Windows x64 隔离制品重跑。首装依次捕获校验 40%、写入 75%、登记与快捷方式配置 95%、完成 100%。卸载在文件占用时保持 10%，释放后实际移除 437 / 717 时为 62%，收尾为 98%，完成为 100%。关闭完成页后核对独立登记、活动候选、启动器和快捷方式已移除。截图位于 `dist/windows-setup-overall-20261113/screenshots`，截图包只延长真实阶段和计数的停留时间。

移除完成页进度后，同日在 Windows x64 隔离包重跑安装和卸载。分别观察到 95% 登记及 98% 卸载收尾直接切换到结果页，结果页的截图和控件树均无进度条或百分比。截图位于 `dist/windows-setup-result-20261113/screenshots`。

2026-11-12 Windows x64 本机构建生成 220,193,792 字节的桌面安装 EXE，SHA-256 为 `c756c300fd05e11e27b41bec34297f12e0e3c736c696dc9a80f93c66734cf75f`。候选 `8fd91a51896815438e9fb6183ab9d738f0fe1c49ba90a3da07a7fc7881b6629e` 由正式校验器核对包内 Service 与 Runner V7。使用同一归档生成独立安装登记的验证安装器，测试路径位于仓库外。EXE 使用本地生产配置构建，签名与公开发布资格仍按正式发布门禁核验。

同一候选在两个独立 Profile 启动真实桌面窗口。无 Git 的 PowerShell 组实际观察发送、工具运行、人工批准与拒绝、原 Job 停止以及下一条命令恢复。确认外部写入和联网分别在授权后才产生效果。完整 Git Bash 组实际运行中文管道和工作树查询。两组都从窗口菜单正常退出，核实原 Main 与 Service 死亡并冷读持久终态。卸载移除测试登记、启动器和快捷方式，保留两个测试 Profile，正式安装登记与快捷方式摘要一致。窗口过程和持久证据在本机 `.cache/powershell-fallback-a45ca81cf/installed-v7-0ada4db1.json`，原生权限矩阵归 [Windows Shell 沙箱](../../../docs/active/windows-shell-sandbox.md)。

2026-11-12 集成终端 Shell 的本地未签名候选 `0ca18542297ec2b3d344d8ed9d96afabe9dcd292140bd8904bab8000bb44627e` 通过正式制品校验器。Windows x64 安装 EXE 为 220,323,328 字节，SHA-256 为 `585f3e1d4044bb12338f747bfb8f1801ff0558b7b974ff5b8f95418990e14bf8`。同一归档的验证安装器使用独立安装登记与 Profile。设置行为与窗口验证归 [Desktop owner](../README.md#windows-集成终端-shell)。

## Windows managed Native 当前实现

新完整 Native 首次安装复用同一 Terminal 的 Node SEA verifier 和固定 Node-API 插件。旧 Bun 完整安装的稳定前门不能直接切换到 Node 候选；安装发布前返回 `native_windows_node_bootstrap_requires_new_prefix`。此限制属于有固定四文件前门的完整 managed Native，桌面专用 Setup 沿独立整树替换合同。新 Windows 制品未取得实机安装资格。以下 Bun 制品记录保留原范围。

正式 Main 的数据权限异常与用户明确发起的备份／定点修复归 [Desktop 权限恢复 owner](../README.md#windows-数据权限预检与恢复)。它位于原可信候选准入之后、Service／SQLite 之前，保留正常私有 ACL、独立使用权与原数据完整性拒绝；不更改安装包 ACL 或创建链。后端和隔离 Main 回归不替代本节完整 installed 窗口／维护资格。

2026-10-17 范围审查的完整 Native候选为 `bc08c49a12bc7c767cd4fb6f68e7e08755dc46721ed8ea771549efadd5bdb2d2`，inner 为 Terminal `e9046c4e26d627ba99875131733a19d16545f71f45c8723af25a37ba88bc6e0a`。官方 Electron 输入73份原文件在 build 前后逐项保持。原整链 r20 中，A/B 两个实际窗口均读取原完整历史、实际 exit0、Main/Service dead、Job0/未Terminate、strict Close 和双 EX；第三次回退 A 时触发原45秒 UIA截止，基础120秒和维护180秒均未扩大。第三冷窗口、恢复后窗口与 installed Native维护没有通过证据，不能以两个窗口或 Node探针授完整资格。

随后只补 bundled 原 manifest 许可来源的 r23 构建及完整校验候选为 `a7f3f3f24136de32437e2b3012d8c82e9de162904f2af06bbeaee7ce6ed61e97`，inner 为 Terminal `9f594260a611c2c5742785daa46cf7a681711fadcce7f5885e5f340e073c7025`。官方73份输入原哈希保持；当前 r23 没有第三冷窗口或维护恢复通过证据，原失败与门禁继续保留。

[Windows installer](../../../scripts/release/windows-native-install.ts)复用明确 archive/prefix 的用户入口。format=2 marker 固定首次候选的四个稳定文件：`bin/kite.exe`、`kite-tui.exe`、`kite-desktop.exe`、`native-verifier.exe`。后续安装及 rollback 只切 current/previous，bootstrap A 保持；运行中的 A 持原 outer/inner 使用权，新启动核当前候选。两个 use 键分别为候选 ID 与 `SHA256(ID + NUL + "terminal")`，均位于 prefix 外同一私有协调 namespace，不与 Profile 交叠。

Windows x64 的新 Native 构建以同次 Terminal 的共享校验器 SHA 和大小绑定 C 前门。`native-verifier.sha256` 与可执行文件的清单记录必须匹配，首次安装从已核内层复制同一字节到 `bin/native-verifier.exe`。旧候选从原 `app/native-verifier.exe` 安装，使用未声明共享校验器的旧 Terminal 构建时也生成该独立资产。升级和回退继续使用首次安装的稳定前门与精确字节，Main 的创建证书仍绑定实际 `bin/native-verifier.exe` 进程。取舍见[共享 Windows 校验器决定](../../../.agents/notes/implemented/simplification/2026-11-11-shared-windows-verifier.md)。

[Root release build port](../../../scripts/release/windows-native-build.ts)负责固定 compiled verifier 与静态 C 前门，Desktop builder 只通过明确 typed port 调用。源 Terminal 与 Electron 完整原文件 pin 覆盖复制和所有构建 await；Windows 拒绝 links，以私有原 HANDLE 创建／写入／flush，并核全部文件、空目录及实际 SQLite 引擎。Terminal 的 v1 文件库存不记录空目录，[构建复制入口](../scripts/build-native.ts)在私有文件复制后，按已封存的 Worktree 三文件闭包重建准确空 hooks 目录，再交原 verifier；[复制回归](../test/isolated/native-terminal-copy.test.ts)直接调用同一入口，并用真实完整性校验验证缺目录拒绝、重建后摘要一致和非空 hooks 拒绝，Windows 安全 API 替身不授原生构建资格。新副本的 Electron EXE/DLL 使用 APPDIR/System32 静态 import 搜索；固定 Bun/helper/C 使用 System32。构建新副本时可将严格受限的 RVA v2 delay imports 转为普通 imports，包含实际 GUI Electron；最终仍必须无 delay directory，未知形状、bound／unload、PE不完整或不合格 loader 字段拒绝。Electron 仅另接受准确系统 basename `winspool.drv`／`bthprops.cpl`，不允许任意DRV/CPL、路径或 console 模式豁免。verifier 由持续 pin 的私有候选 Bun 子进程编译，输出权限继续严格复验，转换和私有编译合同归 [Terminal owner](../../cli/docs/terminal-release.md#windows-managed-terminal-当前实现)。原 publisher 文件不修改，SHA 仍只提供完整性。

2026-10-17，本机实际 Electron44.3.0 的52组 delay imports 经有界转换后，完整分发内7个EXE/DLL均通过原最终门禁。[真实运行回归](../../../tests/isolated/unified-agent/windows-native-runtime.test.ts)将其复制到新私有输入、保持原分发完整SHA不变，转换副本在空PATH、cwd伪造 `ffmpeg.dll`／`dbghelp.dll`／`USERENV.dll`／`WINSPOOL.DRV`／`bthprops.cpl` 下实际返回准确版本，独立 `node:sqlite` 探针通过；这是运行时与引擎资格，不代替完整 Native 包、可信创建链、Main/Service窗口或安装维护验收。提前加载会让缺失可选系统模块／符号在启动时失败，其他Windows变体仍须实际验证。

同日实际构建并完整验证Native候选 `2f48062728567c921031fd59d031cb5508c94fd4fb648927c7dff243e18f7230`（99个outer清单文件），准确inner为Terminal候选 `5d46e164e8828f78e4cbe7f2cf6d9e26f694c9a472fd59a92953c788c3733261`。使用已安装Electron的72个原始文件创建同字节私有输入，原分发SHA不变；实际MSVC／renderer／四前门及compiled verifier生成完成。公开Native smoke成功，返回 `closure:true`、`electronVersionProbe:true`、`node:sqlite`3.53.4及 `mainLifecycleQualified:false`。实际归档322,733,021字节，SHA256为 `83242758a348a10e33a01cd853b97cc7c3f0e63ddbf6b19612ad1682a800ad5e`，已独立重算。

原完整安装调用者在pack阶段从81.836秒至530.214秒，随后按原120秒基础门禁报 `windows_native_qualification_deadline`；未进入unpack／install／UIA／维护。保留失败私有根与phase记录，不将完整build／smoke／pack当窗口和安装成功，原180秒维护、窗口／命令期限及真实创建链要求均未放宽。

原对象/Node配套修正后，再次实际构建并全量验证新Native `3475591a7e390500999efd7b88fa19e61523d5d6b22f054113911f2404b4407e`（99个outer文件），准确inner为Terminal `16a4041941db8870d828a492adbf6dce37d51704ae18618e7803d613d2687050`。包内Main核实包含原owner借用、准确固定argv、detached Service和原启动/清理错误同时保留。公开smoke再次成功，Electron44.3.0/独立SQLite3.53.4、closure/version为true，仍明确 `mainLifecycleQualified:false`。新实际归档322,733,688字节，SHA256 `097a2baf427b227d731ba2357b75bc788a8d54d5b59b9f998b90d7380ffde998`，已独立重算并核clone manifest身份/sidecar。

新完整调用者仍失败：pack从51.056秒到399.228秒，399.230秒按原120秒门禁拒绝，未进入unpack/install/UIA/维护。该次与整组回归并行，耗时只说明实际这次调用，不能当独立性能基准；资格也不因并行负载豁免。失败根和原阶段记录保留，无正式窗口启动或模型调用，Windows完整安装/窗口/维护资格继续未取得。

已安装 `kite-desktop.exe` 先由 C 清除运行时环境注入、固定并 pin 自身和 helper；[compiled verifier](../../../scripts/release/entrypoints/windows-native-verifier.ts)取得当前完整 outer/inner 文件 pin 与双 SH 后才创建 Electron。C 用实际创建的 helper HANDLE 出具第一份私有证书，verifier 用实际 Electron HANDLE 出具第二份；[Main 原生端口](../native/windows-access/README.md)在 BrowserWindow、Profile、UI SQLite 和 Service 前分别核真实管道 server/client PID、原 FILETIME 与固定映像，并取得自己的完整文件 pin／双 SH。Service 再取得独立使用权，继承 HANDLE 不作所有权证明。缺交接、伪造 parent、漂移或错误证书继续拒绝；原 SDK 允许指定 PPID，不能单凭 PPID/映像相同放行。

实际Windows改写/重命名反例促使C/Node-API/Bun祖先pin显式请求FILE_TRAVERSE，普通候选文件pin请求GENERIC_READ；仅属性HANDLE不足以建立原共享保护。LockFileEx区域锁改为必要的只读权，与真正只读全文件pin相容，UI SQLite读写权保持。Main的配套启动由可信装配端口借用自己已接纳的原生owner，以WeakMap绑定原root/digest/entry/Bun/build；复制/伪造/closed owner拒绝，原child退出未兑现时Main不得关闭，不在Electron加载Bun FFI。子Service继续独立完整准入。

[Node适配器](../electron/node-process.ts)接受原两参数或同一候选的四个准确固定Bun参数，拒绝额外或改投配置；Windows使用detached创建保私有stdin/双输出，让Main异常退出后Service实际EOF清理，避免libuv默认Job直接强杀。2026-10-17三个完整文件[原生owner](../test/isolated/windows-node-access.test.ts)、[原Main借用](../test/isolated/windows-native-candidate.test.ts)、[真实Node参数](../test/isolated/node-process.test.ts)共11项/74断言通过；包含实际Electron/Node-API、父原HANDLE异常退出、清理barrier期间EX仍busy、子进程自然0与原UI/锁归属，以及退出未知不归还借用的有限端口反例。不是完整installed窗口验收，取舍及原生证据边界归[原对象决定](../../../.agents/notes/implemented/bug-fix/2026-10-17-windows-original-object-sharing.md)。

Windows 登记后的独立 Terminal CLI/TUI 转发到 Native 稳定 C 前门。双 prefix SH 内核原 nonce、完整候选和原 ID；内部 expected-candidate 只收窄选择。Native 自身准入若已合法切 B，明确返回 `cli_registration_changed`，不会将已核 A 的证据用于 B；接纳 A 后释放 selection，仍允许正常升级。普通任务与 `kite.exe maintenance` 随该候选进入原业务／离线维护，未增加 journal 自动决定、模型调用或数据回退。

rollback 在发布前完整预检仍由原 nonce 持有的 Terminal；正常 Terminal 卸载后的历史登记不重建旧前门。Native uninstall 取得全部 outer/inner EX 和完整树 DELETE owner，复用 genuine removal 验证，原 nonce CAS 撤销外部前向登记，再逐原对象删除并确认根消失；Profile、配置、项目和独立备份不进入删除输入。opaque transfer／关闭未知保留本调用完整锁组与原资源，所有文件确认关闭后才释放使用权。归档私有 scratch 也只以完整库存的原 DELETE owner 清理。

本机现有Windows有限证据覆盖真实私有ACL下的归档／安装控制、原关闭未知、实际MSVC前门、Bun及上述Electron引擎探针；完整Native包、pipe、Main／Service窗口和installed维护恢复仍按各自实际结果判断，不将有限夹具升级为整链资格。未dispatch hosted Actions。raw `release:native launch --directory` 的 Windows 限制保持，正式 Windows 入口是已安装的稳定前门；desktop 前门当前只接受无附加用户参数的启动。完整用户链必须在 Windows 核普通任务／历史、A→B→A、维护新 Store 原完整结果冷读零重放、准确退出、双 EX 及卸载保数据，才能关闭该平台能力。

[Windows 安装正式调用者](../../../tests/fixtures/unified-agent/windows-native-installation.qualification.ts)现已接入 release-candidate 的 Windows build／verify／smoke 后；[现行 CI 守卫](../../../scripts/check-unified-workspaces.ts)拒绝缺失、错平台、忽略错误、命令替代及前置顺序错误。该 caller 以同一个已核候选归档／解包并删除自己的构建副本，零参数启动稳定 `kite-desktop.exe`，由系统 [UIAutomation driver](../../../tests/fixtures/unified-agent/windows-native-uia.ts)操作实际会话输入、提交、完整回复和默认应用菜单退出，不增加产品调试参数或假创建证书。窗口关闭只隐藏，不能代替退出。

验收源码保基础安装120秒、driver45秒、窗口／操作10秒和独立维护180秒预算。A任务完成后运行中选择同代码合成版本B，原A Main／Service与双SH继续固定；退出后冷启动B、rollback再冷启动A。全部原进程退出、两候选双EX可取得后，从 installed `kite.exe maintenance` backup／inspect／restore／status 恢复新Store，第四个新窗口冷读原完整结果；准确原Command／Run／Execution、sealed输出和Provider恰1独立核对，最后唯一卸载保Core／Native DB／config原字节。该B只改变未发布见证manifest，不计真实跨代码兼容。

进程证据来自本次创建前原Job及成员原HANDLE／FILETIME／实际映像，PPID仅用于在已证成员中定位Main与Service；正常退出另要求 `terminationRequested=false`，防止fixture强制终止掩盖产品收尾失败。MCP公共v3语法保持原投影。源码／本机控制流通过不证明Windows UIA树、菜单、嵌套Job、两跳证书或维护正向运行；完整caller尚未在Windows执行，平台与阶段门禁继续保留。取舍与验收依赖见[Windows调用者提案](../../../.agents/notes/proposed/testing/2026-10-10-windows-native-installed-caller.md)，实际有限证据见[本轮进度](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10windows-native-正式安装版本切换与维护调用者源码)。

Windows 注册 CLI/TUI 另由 [完整 installed TUI caller](../../../tests/fixtures/unified-agent/windows-installed-tui.qualification.ts)消费准确 Terminal／Native 候选：同一个独立稳定 `kite-tui.exe` 先用 Terminal，再用登记后的 Native 双层闭包；实际键盘任务、全文／思考、导出、准确取消、草稿及冷读零重放，正常退出须原 Job 未 Terminate／完整 EOF／Job0／双 EX，撤登记和最终卸载保原数据。此调用者已接 release job，但 Windows 实际运行尚未取得，按用户安排交后续 Actions；它不把窗口、真正跨代码切换、Shell／RSS 或阶段资格记为通过。完整合同及预算归 [Terminal owner](../../cli/docs/terminal-release.md#windows-installed-tui-正式调用者)。

同一安装调用者支持显式 `--predecessor=<absolute-original-native>` 真代码分支。[统一入口](../../../tests/fixtures/unified-agent/windows-cross-version.qualification.ts)消费从 `a45ca81cf` 原源码和锁文件构建的 Terminal 与 Native。两版 `0.1.0`、源提交与干净状态、候选及实际 Agent SHA 差异、当前合并 Schema 和前驱 SQL 完整摘要均独立核对。旧 `4a4c0e440` 的11项锁输入、原837输入和历史迁移由 [Terminal 输入守卫](../../cli/docs/terminal-release.md#验证边界)保留原证据范围。

真代码分支通过零参数稳定 `kite-desktop.exe` 验证四个窗口。A完成原任务并持有双SH时，旧前缀拒绝安装 Node B，原选择字节保持，B 安装到独立前缀。B 冷读并明确开始新任务，再用 A 冷读 B 的结果并开始第三个任务，最后用 B 冷读完整历史。验收按实际存储核普通正文或 sealed 描述符的原身份、字节和摘要，每次明确请求都包含此前正文，冷读期间 Provider 次数和业务游标保持。四窗须自然退出并取得双EX。原门禁还要求用 B 的 CLI 执行 backup／inspect／restore／status，再从第五个窗口冷读新 Store，核原 Command／Run／Execution 和 Provider 总计3次。Bun→Node 两个前缀分别卸载并保原数据库和配置字节。基础420秒、独立UIA driver45秒、启动／页面／退出10秒、维护180秒和单个CLI命令30秒均受统一绝对期限约束。Windows 原生整链待实测，原离线 CLI 仍只接纳 DB1–10，而普通 Native 的已读回执可写到 DB12。具体边界见 [维护 owner](../../../packages/agent/src/maintenance/README.md#会话工作文件与-manifest-v20)和 [Terminal owner](../../cli/docs/terminal-release.md#windows-真实代码升级与冷回退调用者)。

## 完整身份与生命周期

[Native verifier](../../service/src/native-runtime-assets.ts)核 outer 的准确普通文件、目录及受限相对框架链接，并独立完整核 inner Terminal。tar 只存普通字节和封闭链接声明；拒绝 traversal、真实 tar links、重复/PAX 冲突、外部 hardlink、篡改及未声明条目，物化后重新核两层。目录中的 Electron 空 locale 也必须在准确清单内。

普通文件的 SHA 沿[Service 只读 leaf](../../service/src/asset-file-hash.ts)核完整内容。通过原大小检查且不超过 64 KiB 的文件保留 `readFileSync`；较大文件逐块读至 EOF，每次完整核验按需分配并复用一个 1 MiB buffer。Main 的同步 `noAsar` 范围继续核物理 archive；初次核验、原双 SH 后复核与 Service 自有准入全部保持。分块内容及两层末字节拒绝由[原 Node-safe 完整测试](../../service/test/isolated/native-runtime-assets.test.ts)核对，实际首屏失败、读取对照与窗口／完整默认资格归[本轮进度](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09普通启动完整回归与制品读取)。

Node Main 持 outer/inner 两个 SH，继承锁的 helper 只关闭副本，不对 shared description UNLOCK。Service 与共享 daemon 独立保两 root 使用权。Native proof 只接受已完整核验 inner Terminal 清单中的 `service` 或 `daemon`，两种入口均固定同一候选的随包运行时、`native-<digest>` 与 outer manifest；CLI/Electron 入口不获得 Service 身份。verify 与 private startup proof 的原 build/entry/runtime/manifest 必须准确相等，默认 Files 保护两个实际完整 root。关窗口、关闭 Client 或父进程退出不等于全部 lease 已释放；原运行/资源确认关闭后才释放。卸载先取得所有候选的双 root EX，busy 立即拒绝，不猜 PID 或强杀服务。

卸载在原安装 EX 内先核封闭管理结构、准确候选 ID 和 outer/inner 真实目录，再按稳定顺序取得所有候选双 root EX。busy 在内容读取前拒绝；候选同时损坏且使用中时先返回 busy，释放使用权后仍完整核 manifest、文件字节和 digest，损坏不能卸载。全部 EX 持有后完整核每个原候选，删除前再次核管理结构、active/previous 与候选 ID 集合；漂移拒绝，部分取得的租约沿原 finally 释放。原登记 nonce CAS、rename/fsync、数据保留和真实卸载保持，完整验证不靠缓存。

不可变 releases、两行 active 与 previous 只控制后续启动；旧进程继续使用原候选。升级与回滚不替换数据、不恢复旧备份。Native 私有 `node:sqlite` 引擎在选 Profile/打开 UI 数据库前实测并核 manifest；Service 的 SQLite Worker 引擎另行选择，两者不互相冒充。

## 标准命令登记与卸载恢复

双 prefix 以固定顺序持安装 EX，0600 封闭 metadata 保存 terminalPrefix/nativePrefix/candidateId/nonce。标准独立前门在持有 Terminal SH 后复核双方原 nonce、Native active 与双 root SH，再执行 Native 的随包运行时和固定 CLI/TUI，配套 Service 同属该闭包。读取不授予其他 Profile 或任意可执行入口。坏登记、nonce 漂移或 active 漂移拒绝，不自动回退。

组合 Native 提供 `kite`、`kite-tui` 和 `kite-desktop`，桌面专用 Native 提供桌面前门。安装更新只更新自己仍拥有的登记，卸载沿原 nonce 撤销。已有登记的组合安装切到桌面专用包时，macOS managed 安装先撤销其原登记，再切换 `active` 并移除 Native 的终端前门。Windows 使用桌面离线安装器的替换路径，旧安装清理时撤销原登记。独立 Terminal 前门继续提供 `kite`、`kite-tui` 和 `kite maintenance`。如果 shell 缓存了已移除的 Native 路径，执行 `hash -r` 或打开新 shell，并通过独立 Terminal 的 `bin` 使用这些命令。macOS managed 安装回退到组合候选时恢复 Native 的终端前门，重新登记需显式执行 `register-cli`。

macOS managed 安装中，当前或上一个候选包含维护脚本时，`kite-maintenance` 使用该候选的包内 Node。这使从组合包切换到桌面专用包后仍可校验和回滚。全新桌面专用 managed 安装只创建桌面前门。

[登记迁移验证](../../../tests/fixtures/unified-agent/native-terminal-split.qualification.ts)消费独立 Terminal、组合 Native 和默认桌面 Native 三份真实制品。升级前后的 `kite` 均完成任务，独立 `kite-tui` 通过真实 PTY 读取原会话、完成新任务、正常退出和冷重开。三个请求各执行一次。`kite maintenance backup` 和 `inspect` 核同一 Store，Profile 数据库字节保持一致。当前包内 Node 的合并制品已在 macOS arm64 验证切换和双向回退。旧 Bun 候选的 Windows x64 ConPTY 记录保留其历史范围，当前 Windows 原生链仍需实测。发布 CI 在 macOS arm64 和 Windows x64 执行此验证。

独立 Terminal 正常卸载后，Native 的反向登记只保留历史归属。省略 `--cli-prefix` 的升级在旧目标已不存在时仅持 Native 安装 EX，继续完整核候选和发布 active；不会锁定或重建旧 Terminal，也不会自动登记后来重建的目录。仍存在的隐式目标以及所有显式目标继续完整验证、固定顺序持锁和 nonce CAS；无效目标拒绝，不能据目录缺失放宽明确登记。Native 回退和卸载保留同一可选前门边界。

回退在双 prefix EX 内固定仍存在且由原 nonce 持有的 Terminal 目标，先完整核其候选与登记身份，再发布 Native active 并更新该目标。已知损坏在发布前拒绝，Native active、反向登记和独立前门登记均保原字节；修复候选后原前门仍可读取原选择，再明确回退。目标已正常卸载时仍可独立回退，后来其他 Native 的 nonce 不被夺回。这一预检不增加跨 prefix 崩溃原子性保证。[登记完整文件](../../../tests/isolated/unified-agent/cli-registration.test.ts)新增真实字节损坏反例并保原五项；有限候选只核安装格式与选择合同，不能代替真实代码升级、窗口或平台资格。

macOS 的[登记完整文件](../../../tests/isolated/unified-agent/cli-registration.test.ts)及[原安装窗口](../../../tests/isolated/unified-agent/native-install-lifecycle.test.ts)已验证这一正常卸载后升级链：原两个真实窗口保完整任务、冷读、Provider恰1、Store metadata／View、回退、双lease退出及卸载保数据。原120秒整例／45秒driver不变；两个候选是同源码版本标记差异，只证明安装选择与当前消费者，不充当真实旧代码兼容、DB9或已发布样本。准确输入和实际失败归[本轮进度](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10安装升级与维护关闭所有权)。

## macOS 安装版离线维护

Native 自带 `bin/kite maintenance` 和登记后的独立 Terminal 前门均先核完整候选、持原使用权，再调用同一[离线维护 leaf](../../cli/host/maintenance.ts)。明确的 data root/profile 与制品目录分开；维护不连接 Service 或 Provider。macOS 的[原 PC 窗口用例](../test/isolated/native-background-bundle.test.ts)在原三次普通窗口退出后，用实际 installer API 安装完整 Native 和独立 Terminal 并登记，实际 `bin/kite` 执行 backup、inspect、真实时钟下的 GC、restore 和 status。DB8 备份为 manifest v17；最近删除仍保留宽限。过期清理由候选内 Bun 执行外部夹具，调用安装包的公开 `runNativeTerminalCLI` 选择器，仅推进夹具时钟，不修改原时间戳或回执，也不新增生产时钟选项；这一步不冒称实际 bin 等待了七天。

恢复生成新 Store，原目录的 Core／Node 私有 DB 字节和 inode 保留；恢复的私有文件与所选 SQLite 备份快照字节相同，公开只读 Store 核原历史、执行和 Command，旧 Store 身份拒绝。维护期间 Provider 不增加。实际卸载取得所有安装候选 EX，保独立 Profile、配置、项目文件和备份；原三 Service 正常退出、准确所属进程为空、原候选两层 EX 可再取。准确结果归[进度](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08native-安装版离线维护)。该有限链不覆盖恢复发布中断的 reconcile、新基线发布后的前版样本、任意版本或全部 W19／三平台资格；DB8 的旧代码运行边界另见下节。

[安装版 PC 恢复中断](../../../tests/isolated/unified-agent/native-restore-interruption.test.ts)另补 macOS 的目录缺失入口：现有 source 恢复观察点暂停在旧 Profile 已移走、journal 仍为 prepared，使用候选内 Bun 和所选引擎，真实 SIGKILL。未修改的 installed Main／Service 在持锁和强杀后拒绝业务准入，不创建空 Profile／Core；稳定锁和原目录字节保持，其他 Profile 可用。包内 `bin/kite maintenance status/reconcile` 先绑定原 ID／digest 明确 rollback；同窗重新加载读回原 Store、后来保存的 Session，候选内公开只读 Store 核原 Command 与 Core／配置字节，保留的恢复候选完整字节也保持。窗口及所属 Service 实际退出、Profile 与双制品 EX 已取后，才在同一观察点再次准备恢复，完整执行原 complete 腿：新 Store、备份 Session、准确 Command 不存在、普通退出和唯一卸载保数据。Provider0、180秒整例／45秒单driver／10秒窗口及原 complete 全部断言保持；新增 rollback 不重复完整 Model／问答展示，也不代替 installed restore 全中断矩阵或整个 R07／W19。准确当前结果见[本轮进度](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10db9-版本切换与安装版维护恢复)，此前仅 complete 的范围保[原证据](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08安装版-pc-恢复目录缺失边界)。

## 真实代码升级与冷回退

[跨代码窗口验收](../../../tests/isolated/unified-agent/native-cross-version.test.ts)使用 [Terminal 同 Schema 前驱](../../cli/docs/terminal-release.md#验证边界)的 Bun 提交 `a45ca81cf`。旧源码按原锁和 builder 生成干净候选，夹具核原始制品、Core Schema 摘要、Agent 和窗口代码差异，并验证归档搬迁。旧 `12628a616` 及更早样本的输入保留原历史范围。`a2b6441f` 继续独立验证旧程序遇到当前 Core Schema 或 DB9 私有库的安全拒绝。

当前兼容冷窗口仅沿原申请 GET 核对回执；`unknown` 收到准确 `applied` 回执后可前进，原请求 body、scope、摘要和业务身份保持。状态校准不增加业务 POST 或 Provider，也不修改下方历史日期记录的当时结论。

Windows 的完整 Native [跨版本验收](../../../tests/fixtures/unified-agent/windows-native-installation.qualification.ts)验证同前缀拒绝、旧选择保留、新前缀启动和原 Profile 的窗口冷读。回到原 Bun 前门继续同一会话，再用 Node 前门读取全部历史，卸载两个 managed 前缀后核原数据。桌面专用 Setup EXE 使用本页“构建与安装”的整树替换入口。

2026-10-21合并输入继续沿[Terminal精确原始输入守卫](../../cli/docs/terminal-release.md#验证边界)追加登记：仅 `bun.lock`、UI清单和Agent清单三个当前完整SHA更新至当日审查scope，分别记录Lexical完整resolved闭包、编辑器生产依赖和Workflow Worker资产构建。原三个固定前驱、previous字节、context、11项路径与两份SQL／checksum不变，旧源码仍用自己的lock与builder。Lexical实际依赖增加与Agent仅追加构建分别说明，不借本地短测或Terminal通过宣称Native新整链、Windows原生或完整默认资格。

原a2b／837的legacy workspace投影、SHA和路径隔离按[Terminal owner](../../cli/docs/terminal-release.md#验证边界)保留；当前兼容入口不借用 legacy 投影；只接受原字节相同或同一固定前驱 context 下的准确 raw 配对，两 SQL 仍核原字节及固定 checksum。模型配置在所属Profile与user文件保存同值输入和原字节保护，不改变生产来源选择。

实际 installed `bin/kite-desktop` 启动正式 Main 和配对 Service，经原四窗口完成 A 原任务、升级 B 的新完整正文、冷回退 A 读取 B 全文并继续原会话，再切回 B 冷读三条原任务。当前 B 构建明确选择 `processHostFixture: native-extension-reference`，mini-review只属测试装配；未注册到默认产品。升级时运行中的 A 仍持原 outer／inner且卸载 busy；四次普通退出后全部候选可独占。指针切换与卸载保 Core／Native私有库 inode／完整字节及配置，回退不恢复备份。原正文由真实窗口按钮和 Main／HTTP 完整读取，冷读保原 Command／Run／Model、正文／hash／ref和Store游标；B的352041B全文实际进入回退后新模型。原持久caller不恢复成hot输入，Provider总计3。

当前 macOS 第四个 B 窗口先沿原侧栏产生实际 DB8 的 unknown 移除申请并保存完整私有字节／inode／配置，再沿正式“会话工具→扩展能力”调用 Analyze。唯一成功 POST 的回复丢失后原申请保持 unknown，实际 Node owner 升为 DB9；完整七字段 request／原 body、scope与摘要保持，实际 Core Job完成。首个 finding精确绑定此前独立读取的原 B Model Execution完整result和已核全文的sealed reference，不能把Model preview冒充全文。普通退出后实际包内 `bin/kite maintenance backup/inspect` 核 manifest v18／DB9／原Store，inspect使用backup返回的唯一目录；备份不修改原私有bytes／inode或配置。原两次独立冷窗口随后只交换代码指针：兼容A可读取原DB9草稿与unknown申请，Core三条历史完整GET，原DB9字节保持；切回B保原两类unknown申请，明确原GET查回移除回执与完整扩展Command／Execution／finding／reference。查回不增加POST或Provider，业务事实和读游标保持；六个所属Service普通退出、双EX及最终唯一卸载保数据。此前实际DB8拒绝链只保其[原冻结范围](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08native-db8-真实代码回退)。

2026-10-11历史macOS在Service精确来源入口匹配修复后，原整文件1pass／643条Bun断言／actual0／221.20秒及实际driver断言；原420秒整例／120秒四窗口driver／60秒冷段／15秒窗口保持，同一安装候选最终只卸载一次。准确当前输入、两个原版本完整文件与集成门禁归[本轮进度](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-11native-完整历史校准与正文解析)，此前234.736秒及四次真实失败只保[原输入范围](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10db9-版本切换与安装版维护恢复)。该历史结果证明当时两个真实代码候选的限定链；已发布predecessor／T029、任意旧writer、远端Provider和Linux／Windows资格仍各按适用契约核对。生产安装与回退逻辑本片未改，Windows限制保持。

2026-11-13，macOS arm64 用固定 `a45ca81cf` 和 `a2b6441f` 前驱运行整个跨代码文件，两项通过。DB8→DB9 场景沿实际移除确认和历史结果查询入口。隔离窗口 driver 模拟已读回执写入失败，让旧格式的备份链保持在 DB9，并核实确有已读请求经过。DB11／DB12 离线维护的支持范围见 [维护 owner](../../../packages/agent/src/maintenance/README.md#会话工作文件与-manifest-v20)。

原文件另有独立300秒legacy安全拒绝整例，实际构建a2b Native，两个独立owned Profile分别核当前公共Store生成的0002拒绝，以及原a2b Core0001配当前production PrivateData合法生成DB9后的私有拒绝。前者观察旧Main诊断缺能力，后者实际触达 `draft.read` 的 `draft_storage_unavailable`／callerUnavailable；两者均Provider零、普通退出、准确PID死亡／双EX，并在退出与卸载后核Core／private／Profile和user配置的完整bytes／inode。前者不冒称已执行私有拒绝，后者不复制、恢复或降级Core。当前source owner生成数据的负例不替代首个test的完整当前Native安装资格。

2026-10-19当前macOS主升级场景定向1项/1435条Bun断言/156.58s通过。B输入明确独立工作，保完整352041字节，并以真实public/raw/decision/business/Run/成功Model Source替代按Run数组位置推断；正式lookupInput查回原公开ID，完整ModelInput仍由原Native reader读取。Native journal同步采用共享业务绑定校验，不再要求业务Run.origin等于原public ID；旧技术steer和scope/digest、取消、extension与冷零POST保持。原A/回退A、3次Provider、原历史/bytes/hash/inode、四暖窗口及两DB9冷窗口、备份/安装/回退/卸载/退出双lease及原420/120/60/15秒预算保持。本次定向未运行另一个legacy拒绝case，完整默认的整文件证据归[测试owner](../../../tests/README.md#子-agent-协作-v11-验证)，不由定向主场景推导跨平台或发布资格。

## Linux 真代码升级与冷回退

同一完整跨代码文件对macOS/Linux执行；历史Linux组合使用首次接受准确builtin SQLite3.53.2来源的原提交 `1b796e30ab0f3638767095d86d4afd374eae662a`，由该源码自己的Terminal和Native builder生成候选。历史3140前驱在Linux的原来源拒绝保留；不修改旧源码、白名单、版本文字或数据库。相同依赖/基线、源码前后干净及成功删除原源码的守卫继续适用，取舍归[平台前驱决定](../../../.agents/notes/implemented/testing/2026-10-07-platform-real-code-predecessors.md)。所有平台都核实际Agent字节与inner/outer候选不同；Mac两个前端差异断言原样保留。该历史Linux组合实际变化为包内Agent worker，Main制品hash不同、renderer字节相同，不能据此认定renderer逻辑演进已验收。

Linux使用实际Electron dist和manifest executable路径、Node `.mjs`、准确`ps` argv/父PID，仅转发`DISPLAY`/`XAUTHORITY`。[窗口driver](../test/native-cross-version-electron.fixture.ts)四次均显式开启Chromium sandbox并核实际sandbox/contextIsolation=true、nodeIntegration=false及没有no-sandbox。原420秒整例、120秒driver、15秒窗口和上述原Store/Command/Run/Model/正文/caller/零重放/双lease/数据保留断言不变。Canonical Ubuntu Base24.04.5、Docker VM原生arm64、UID501、Bun1.4.2/Electron44.3.0/Node22.21.1/Xvfb实际整文件1pass/374条Bun断言及driver断言，actual0/171.298秒，四次窗口普通退出结束于driver80.070秒。回退后的新任务实收到352041字节B全文，最终卸载保Core/Native DB/config原字节和inode。

准确候选、失败、摘要和阶段回归归[本轮进度](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07linux-真实代码升级与冷回退)。release candidate另在macOS和Linux调用整个文件，Linux在Xvfb中执行，静态守卫拒绝平台缩减、关闭、echo、过滤或缺显示。上述结果只适用于当时锁输入和源码；当前固定 12628a616 的 Linux 兼容组合尚未运行，按用户顺序在重构完成后交 GitHub Actions 核对。历史Linux arm64两个本地原始代码候选的有限兼容链不替代已发布predecessor/T029、G1 hosted Ubuntu x64、Windows、四Auth/Vault、新signal故障窗口或全部§35/T/E；生产安装、回退和默认宿主Shell语义没有修改。

## Linux arm64 安装生命周期

[原完整安装文件](../../../tests/isolated/unified-agent/native-install-lifecycle.test.ts)现对 macOS/Linux 执行，临时目录使用平台 `tmpdir()`，Electron 发行目录按实际平台定位，Node driver 使用明确 `.mjs`。Linux 只转发显示所需 `DISPLAY`/`XAUTHORITY`；`ps` 使用实际 executable argv 列，仍核准确 Main 父 PID。原 120 秒整例、45 秒 driver、10 秒窗口等待及全部业务/双锁/保数据断言保持。

测试 driver 的正常退出由 Playwright `close()` 发起一次 `app.quit()` 并等待真实 Main 退出，控制用 HTTP 请求明确关闭连接；不调用 `process.exit()` 代替资源清理。2026-10-08 原安装用例在本机以 driver36.428秒自然退出、计时器未触发通过。先前完整默认曾在原45秒窗口失败，耗时包含完整安装校验；定向通过与这次夹具清理不单独证明并发默认图或每个平台通过，当前完整结果归[进度证据](../../../docs/plans/unified-agent-refactor-v1-progress.md)。

[实际 driver](../../../tests/fixtures/unified-agent/native-install-electron.ts)明确 `chromiumSandbox:true`，两次窗口均核全局没有 `--no-sandbox`，且实际 BrowserWindow 的 sandbox/contextIsolation 为 true、nodeIntegration 为 false。Playwright 的 Linux 默认会关闭 Chromium sandbox，因此不能沿默认值取得资格。自有容器使用 [Playwright 官方 seccomp allowlist](https://playwright.dev/docs/docker#crawling-and-scraping)的 namespace 支持，保留 no-new-privileges、无 privileged/额外 capability；不向产品或默认 Shell 注入该容器配置。

当前有限实测为 Canonical Ubuntu Base 24.04.5、Docker VM 原生 aarch64、UID501、Bun1.4.2、Electron44.3.0、Node driver22.21.1、Xvfb。完整归档/解包/搬迁和删除原输出后，实际 installed `bin/kite-desktop` 经默认 Main/renderer/Service完成一次模型任务、冷读、同源码版本指针升级/回滚、正常退出与双锁强杀窗口、最终卸载保 Core/Native DB/config 原字节。[Store写锁等待修复](../../../packages/agent/src/storage/README.md#写锁的有界等待)后重新生成的当前候选再次通过，Provider 恰1，1pass/25条Bun断言，71.851秒、driver26.455秒；准确 manifest 分别实测独立 builtin `node:sqlite`3.53.4 和 `bun:sqlite`3.53.2。首次76.692秒的原证据另保。它不是 Linux 真实跨代码/已发布 predecessor、Vault、全部 Native 业务、Windows 或 G1 原生 Ubuntu x64 CI 资格。

此前 x64 用户空间经 Rosetta 仿真的三轮实际失败分别为旧 Node/ESM driver、45秒 driver、临时55秒driver仍撞原120秒整例。失败证据保留，55秒更改已撤销，没有用仿真失败换取原预算放宽。补齐 git 前的 arm64 设置失败也保留。准确输入、原始日志和正常 owned 收尾见[进度](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07linux-native-安装生命周期)。release-candidate 的 Linux 步骤执行整个原文件，Required unit 在 Xvfb 内执行整个默认图；CI 守卫拒绝移除/错平台/echo/过滤或静默关闭显示入口。定义不等于 hosted 通过。

## 公共扩展的安装版正式消费者

[扩展整窗口](../test/isolated/native-extensions-bundle.test.ts) 在制品hash发布前使用固定 `native-extension-reference` 测试装配，将现有mini-review及其可信能力分类加入默认Process Host；分类读取真实页面保存的模式与信任，其他定义继续原默认policy。没有mini-review默认产品入口、额外生产开关或现场改写已发布候选。标准Terminal／Native builder、搬迁和删除原输出、公开installer与 `bin/kite-desktop` 实际launcher保持。

窗口沿正式“会话工具→扩展能力”完成原Model source、schema动作、完整finding、原Mark、明确新business key以及冷原Command／Query；阅读不得增加POST或Model。两个所属Service普通退出后两层EX和保Profile卸载继续检查。准确实际结果与首次权限装配失败归[本轮进度](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09正式-native-公共扩展完整能力)。DB9／v18实际Node维护归[维护owner](../../../packages/agent/src/maintenance/README.md#desktop-db9-与-manifest-v18)；DB9已由上述本机真实代码链核旧版拒绝及当前原GET查回；不授予旧writer支持或全部平台资格。

## 验证与限制

[默认宿主 Shell 生命周期](../test/isolated/native-shell-lifecycle-bundle.test.ts)在 macOS 真实安装并删除全部原候选后，三次沿 installed `bin/kite-desktop` 核页面新建后台 Job、完整保存输出、准确停止、Main/Service SIGKILL 后本次 coalition 全树消失及两次冷读零重放。测试不持 fixture SH，实际 Main/Service 持 outer/inner 使用锁；Service 强杀但 Main 仍在时卸载准确 busy，全部退出后两层 EX 均可取得，成功卸载保 Core/Native DB/config 原 inode 和完整字节。它使用生产默认 Service/宿主 Shell；Service 崩溃后的原未完成状态不改写为停止成功。本机安装入口的 Shell 故障组合已有实际证据，不补齐已发布升级样本、其他安装故障或 G1，准确结果归[安装入口进度](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08默认-shell-实际安装入口与保数据卸载)。

[真实 Native archive/install/lifecycle](../../../tests/isolated/unified-agent/native-install-lifecycle.test.ts)在源码树外删除原候选后启动实际 Electron Main 与所属 Service，验证原数据/cold 读取、升级旧进程固定、双锁强杀窗口、回滚与卸载。[注册验收](../../../tests/isolated/unified-agent/cli-registration-lifecycle.test.ts)核两种 PATH 与真正 80×24 TUI，公共 Store 核三条 Run completed，实际 Provider 3；每次运行中卸载 busy 并保持登记，卸载后原查询、数据库/config/caller bytes 和 cursor 不变。[Files 保护](../../../tests/isolated/unified-agent/native-runtime-protection.test.ts)核 Workspace 中实际 outer/inner 读写保护与邻接正常效果。

[实际安装 stdin](../../../tests/isolated/unified-agent/native-stdin.test.ts)删除构建源后使用 Native 自带 `bin/kite` 启动共享 Daemon，核原问题的空白拒绝与 EOF 等待、新 CLI 进程沿原 Work 回答一次、完整 Provider/历史语义及重复零新 Run/Answer。启动 CLI 退出和工作完成后，Daemon 仍独立阻止卸载；实际 stop/status absent 后才卸载。该证据不包含 Daemon 冷重启或 Electron 窗口。

[有限卸载反例](../../../tests/isolated/unified-agent/native-install.test.ts)使用真实 inner SH 与坏 manifest 验证 busy 优先、失败后的 outer EX 可重新取得、空闲后的完整性拒绝及准确 active/内容保留；两层目录 alias 也拒绝。有限夹具只证明锁与格式合同，真实窗口沿原安装生命周期任务、45 秒 driver 期限与准确退出断言另行运行。

macOS arm64 保原 Bun/Electron、普通退出及上述安装 Shell 故障窗口资格；Linux arm64 仅取得上述完整安装文件的有限资格。纯 version smoke 只核 executable/引擎，`mainLifecycleQualified:false`，不能当窗口验收。其余必要安装故障、已发布 predecessor、Linux x64/Windows Native 生命周期、签名/公证/发布者认证及完整 T001—T114/E01—E14 仍需各自实际证据。当前归档 SHA/manifest 只提供完整性。

完整闭包、双 prefix nonce CAS 和父 shell cache 的持久理由见[Native 登记决定](../../../.agents/notes/implemented/architecture/2026-10-04-native-complete-closure-and-cli-registration.md)；Node/Bun 引擎独立测量见[SQLite 选择决定](../../../.agents/notes/implemented/architecture/2026-10-04-selected-sqlite-engine-and-worker-identity.md)。Note 状态不能替代上述平台和发布证据。
