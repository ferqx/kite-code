# Kite Local Runtime

## 定位

`@kite-ai/kite-local-runtime` 提供本机 App client 与 App Server 之间的 typed transport、profile/config filesystem primitive
和显式 daemon endpoint lifecycle primitive。它不拥有 Runtime Host、Store、Session writer、TUI presentation 或 release policy。

## 公开子路径

- `/client`：stdio、Unix socket/named-pipe transport，App Server connection，Runtime/History/App Control/credential adapters，
  以及 daemon status/shutdown exact codec。
- `/config`：共享用户配置的 owner-specific lock、revision CAS 与 atomic replacement primitive。
- `/coordinator`：仍有生产消费者的 internal coordination substrate；不参与默认 App Server discovery。
- `/service`：Kite profile home 校验、owner-only private directory、daemon endpoint path、PID/start identity 与 dead-only endpoint
  cleanup。

旧 `/manager` export、single-Service manager/client、Native lifecycle request codec、canonical `service.sock`、
descriptor/token filesystem state和 build replacement 已删除。

## Endpoint 与 authority

显式 daemon endpoint 由 canonical profile root 的 digest 决定：POSIX 使用 owner-only
`<runtime-parent>/kite-code/v1/<digest>/app-server.sock` 与 `app-server.lock`，Windows 使用 current-user protected named pipe。
reservation 只记录 PID、OS start identity、instance、build 与可选 socket inode，用于证明 dead owner 后精确清理；它不保存 Store、
Session generation、credential 或启动意图。

`status`/`stop` 在 endpoint absent 时不创建 profile 或 state。alive、identity uncertain、inode drift 一律保留证据并 fail closed；
只有 exact dead proof 才允许清理。daemon protocol/capability mismatch 不触发 stop、replace 或 spawn。

## Profile 与配置

installed Runtime Store 为 `<kite-home>/kite-session.sqlite`；source Store 为
`<kite-home>/source-profiles/<checkout-digest>/kite-session.sqlite`。两者使用相同 exact schema，不扫描或迁移旧 `kite.sqlite`。
Provider/config/credential/Trust 继续共享 canonical config root，通过 file-local CAS 序列化；不存在 global writer lease。

profile 与 private state directory 必须是 canonical、non-link、owner-only 路径。POSIX 收紧为 `0700`；Windows 使用 current-user
protected DACL。路径或 owner 证据不确定时拒绝，不自动修复外部替换的 entry。

## 不变量

- client transport 不包含 Store/Host object，也不自动重放 mutation；
- default local connection 由 parent 直接持有，不通过 canonical discovery；
- daemon endpoint ownership 只管理 process/transport，不管理 Session；
- 不提供 previous-build client、active-candidate replacement、OS service、upgrade watcher、remote discovery 或 compatibility range。

## 验证

`bun run --cwd packages/kite-local-runtime test`、`bun run --cwd packages/kite-local-runtime typecheck`、
`bun test tests/release/app-server-client.test.ts tests/release/app-server-daemon.test.ts`。
