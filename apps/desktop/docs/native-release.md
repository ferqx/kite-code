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

不可变 releases、两行 active 与 previous 只控制后续启动；旧进程继续使用原候选。升级与回滚不替换数据、不恢复旧备份。Native 私有 `node:sqlite` 引擎在选 Profile/打开 UI 数据库前实测并核 manifest；Bun Worker 引擎另行选择，两者不互相冒充。

## 标准命令登记与卸载恢复

双 prefix 以固定顺序持安装 EX，0600 封闭 metadata 保存 terminalPrefix/nativePrefix/candidateId/nonce。标准独立前门在持有 Terminal SH 后复核双方原 nonce、Native active 与双 root SH，再执行 Native 内 Bun 和固定 CLI/TUI，配套 Service 同属该闭包。读取不授予其他 Profile 或任意可执行入口。坏登记、nonce 漂移或 active 漂移拒绝，不自动回退。

Native 自带 `bin/kite`、`bin/kite-tui`、`bin/kite-desktop`；独立 Terminal 前门也可选择该 Native。安装更新只更新自己仍拥有的登记，卸载以 nonce CAS 撤销，不能抹掉后来另一个 Native 的登记。独立前门仍存在时，标准命令恢复该 Terminal。若父 shell 已缓存 Native-bin-first 的路径，删除后该缓存真实返回 127；用户执行 `hash -r` 或打开新 shell 后恢复 PATH 查找。安装器无法清除父 shell 缓存，不留未经用户授权的 stub，不修改 PATH/RC。

## 验证与限制

[真实 Native archive/install/lifecycle](../../../tests/isolated/unified-agent/native-install-lifecycle.test.ts)在源码树外删除原候选后启动实际 Electron Main 与所属 Service，验证原数据/cold 读取、升级旧进程固定、双锁强杀窗口、回滚与卸载。[注册验收](../../../tests/isolated/unified-agent/cli-registration-lifecycle.test.ts)核两种 PATH 与真正 80×24 TUI，公共 Store 核三条 Run completed，实际 Provider 3；每次运行中卸载 busy 并保持登记，卸载后原查询、数据库/config/caller bytes 和 cursor 不变。[Files 保护](../../../tests/isolated/unified-agent/native-runtime-protection.test.ts)核 Workspace 中实际 outer/inner 读写保护与邻接正常效果。

[实际安装 stdin](../../../tests/isolated/unified-agent/native-stdin.test.ts)删除构建源后使用 Native 自带 `bin/kite` 启动共享 Daemon，核原问题的空白拒绝与 EOF 等待、新 CLI 进程沿原 Work 回答一次、完整 Provider/历史语义及重复零新 Run/Answer。启动 CLI 退出和工作完成后，Daemon 仍独立阻止卸载；实际 stop/status absent 后才卸载。该证据不包含 Daemon 冷重启或 Electron 窗口。

资格限 macOS arm64、当前 Bun/Electron、普通退出及已运行的故障窗口。纯 version smoke 只核 executable/引擎，`mainLifecycleQualified:false`，不能当窗口验收。新 signal fault 窗口、已发布 predecessor、Linux/Windows Native 生命周期、签名/公证/发布者认证及完整 T001—T114/E01—E14 仍需各自实际证据。当前归档 SHA/manifest 只提供完整性。

完整闭包、双 prefix nonce CAS 和父 shell cache 的持久理由见[Native 登记决定](../../../.agents/notes/implemented/architecture/2026-10-04-native-complete-closure-and-cli-registration.md)；Node/Bun 引擎独立测量见[SQLite 选择决定](../../../.agents/notes/implemented/architecture/2026-10-04-selected-sqlite-engine-and-worker-identity.md)。Note 状态不能替代上述平台和发布证据。
