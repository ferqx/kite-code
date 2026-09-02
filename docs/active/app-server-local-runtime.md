# 本机 App Server 与 Durable Session Runtime

状态：active

读取时机：修改TUI/CLI本机连接、App Server进程、Session Store fencing、显式daemon/Web、profile或release升级语义时。

验证：`bun run typecheck`、`bun test tests/release/app-server-client.test.ts tests/release/app-server-daemon.test.ts`、
`bun run release:build`、`bun run release:verify`、`bun run release:smoke`、`bun run check:docs-impact`、`bun run check:docs`。

## 当前拓扑

```text
default:
TUI/CLI build X -- parent-owned stdio --> App Server build X
                                             |
                                             v
                                     kite-session.sqlite

explicit:
TUI/CLI -- owner-only socket/pipe --> App Server daemon
Web -------- loopback HTTP ------->        |
                                           v
                                   kite-session.sqlite
```

source 与 installed 的语义相同：默认 client 启动 exact same-build child，不发现常驻进程。source 以 canonical checkout digest 隔离
Store profile，installed 使用 canonical profile。App Server 退出不删除 Session/History。
profile resolver以最近存在父目录的`realpath`加未创建尾部计算无写入的稳定identity，同时保留请求路径；preparation再沿请求路径逐段执行
no-follow/owner校验，并把client与child统一到最终canonical target。Windows daemon endpoint digest忽略display casing；准备后的target会再次
推导默认endpoint，任何真实identity漂移仍会被拒绝。

## Authority

- App Server process 只拥有自身 Host、transport、in-memory projection 与当前取得的 Session execution generation。
- Durable Store 记录 Session facts、单调 `controllerGeneration`、lease、revision、cleanup 与 effect receipt。
- 一个 Session 同时最多一个 execution writer；不同 App Server 可以并行写不同 Session。
- PID、build、socket、client connection 和 Web URL 均不是 Session authority。
- read/list 不取得 writer；resume/handoff/mutation 必须取得并持续验证 durable generation。
- stale generation 不能 dispatch effect、提交 terminal receipt 或补写 late completion；unknown outcome 不自动重放。

## 默认 paired App Server

TUI/CLI 通过 release composition 解析 child：

- source：当前 Bun、当前 checkout 的 Service entrypoint、checkout-specific profile；
- installed：launcher-pinned immutable candidate 的 `kite-service`、canonical profile。

两者都使用 `app-server run-stdio` 和同一 exact protocol/capability set。initialize 的 build identity 必须与 client 配对；失败直接暴露，
不回退 embedded、旧 Service 或 daemon。parent EOF/退出会关闭 child，但 durable facts 保留。

默认路径不监听 HTTP、不构建 Web、不发现 daemon，也不存在 build-drift replacement。

## 显式 daemon 与 Web

`kite server start/status/stop [--server <endpoint>]` 是唯一共享进程 lifecycle。默认 endpoint 是 owner-only Unix socket 或
current-user Windows named pipe；显式 endpoint 仍须满足 canonical owner-only parent。daemon 固定一个 canonical Workspace，并允许多个
兼容 client 连接。兼容依据是 exact daemon protocol/capability，build 仅用于 status 诊断。

daemon 同进程拥有一个 stable loopback Web origin，提供 exact same-build assets、API Docs 与 Browser read-only `/v1`。
`kite web` 只读取现存 daemon status；absent、incompatible 或 identity uncertain 均失败，不 start、stop、replace 或 upgrade。
Browser cookie principal 不能进入 Native mutation/control。

status/stop absent 不创建 profile 或 endpoint state。dead cleanup 必须同时证明 PID/start identity、reservation 与 socket inode 未漂移；
alive/uncertain/drift 全部保留。普通 disconnect 不改变 daemon；显式 stop 才 cancel/drain 并清理 endpoint。

## Store 与版本

新路径只打开 exact `kite-session.sqlite`：

- installed：`<kite-home>/kite-session.sqlite`；
- source：`<kite-home>/source-profiles/<digest>/kite-session.sqlite`。

旧 `kite.sqlite` 原样保留但不可见，不导入、迁移、dual write 或 fallback。source/installed 使用相同 schema、fencing 与 recovery。
Provider/config/credential/Trust 使用共享 canonical config root 的 file-local lock/revision CAS。

release install/upgrade/rollback 只物化 immutable candidate 并切换 active pointer；不发现、停止或替换运行中的 App Server。已运行 daemon
继续使用自己的 executable，下一次 start 才使用新 candidate。没有 active-candidate Service replacement、previous-build client、
后台 upgrade watcher 或 compatibility range。

## 已删除的控制面

- `kite service ensure/status/stop/restart`；
- internal `service run-single` 与 readiness fd；
- single-Service manager/client、canonical `service.sock`、Native lifecycle request codec；
- descriptor/token/instance/lifecycle filesystem state；
- source standalone temporary Runtime Home；
- Service-owned Web listener和每 TUI Web listener；
- 只为旧生命周期存在的 process harness、installer fence 与 stable-launcher readiness forwarding。

## 验证

本机门禁覆盖双 App Server Store 竞争、same-Session fencing、effect crash/recovery、TUI durable resume、daemon 多 client/Web、
candidate install/upgrade/rollback/uninstall。release workflow 在 macOS、Ubuntu 与 Windows 分别运行 candidate build/verify/smoke，
并在 Windows 单独验证 endpoint lifecycle 与 Session Store fencing。

当前macOS arm64 dirty candidate `9e5ebc21d6cf30a6f7f80c7d`已通过本机build/verify与完整smoke；完整default tests与42-file TUI PTY
也已通过。implementation head `af7c7596c2e1b7b4aa6eccb12375aca017b45222`的GitHub-hosted
[run 33659494358](https://github.com/ferqx/kite-code/actions/runs/33659494358)在macOS 15、Ubuntu 24.04、Windows 2025均通过candidate
build/verify/install、paired App Server、显式daemon/Web、upgrade/rollback/uninstall和TUI PTY；Windows另通过endpoint lifecycle与
Session Store fencing/mutation真实进程测试。
