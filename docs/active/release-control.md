# 开源候选版本控制

状态：active

读取时机：修改release manifest、candidate构建/校验/安装、三平台workflow、rollback、release profile或发布状态时。

验证：`bun test tests/release`、`bun run release:build`、`bun run release:verify`、`bun run release:smoke`、
`bun run check:docs-impact`、`bun run check:docs`。

相关：ADR-0051、0052、0059、0065、0068、0069、0093、0166、`open-source-first-release.md`、
`app-server-local-runtime.md`。

## 首发权威

G0验证本地正确性、安全、安装与回滚；G1要求GitHub-hosted macOS、Ubuntu、Windows真实build/install/process/PTY/candidate smoke。
workflow定义、本机单平台结果或artifact上传都不能替代三平台通过。缺结果时必须标记pending/blocked，不得推断成功。

支持入口是本地TUI、foreground CLI和显式loopback Web daemon。默认TUI/CLI各自启动同candidate的parent-owned stdio App Server；
多个进程共享durable Session facts，但同Session writer由Store generation fencing决定。Coordinator、Workspace Worker与独立Gateway
无release executable；remote/LAN不在首发范围。

## Candidate

`release:build`编译`kite`、`kite-tui`、`kite-service`和Web payload，并生成strict manifest、逐文件SHA-256、archive sidecar、
release notes与known limitations。manifest中的CLI/TUI/Service/Web slot必须绑定exact identity；Coordinator/Worker/Gateway slot必须为null，
archive不得出现对应executable/launcher。

默认CLI/TUI connector从同一immutable candidate固定解析`kite-service app-server run-stdio`。source固定当前Bun与checkout entrypoint；
installed固定launcher-pinned candidate。两者把同一个build ID交给client/child并在initialize校验exact server version/capabilities；
不查PATH、不发现running process、不fallback。

显式`kite server start`解析同candidate的`app-server run-daemon`。daemon v2 status携带build诊断与stable `webOrigin`；
compatibility只依据exact protocol/capabilities。status/stop不替换不兼容或identity不确定的owner，`kite web` absent不spawn。

## Build identity 与环境

source build identity覆盖CLI/TUI/Service、packages、release entrypoints、manifest inputs和有界untracked regular-file内容；实际build input变化
必须改变identity。摘要不可用或越界时fail closed。

child环境只复制固定OS/runtime keys与内建Provider的explicit keys。unknown `*_API_KEY`、Workspace dotenv、ambient Kite home、
NODE/BUN injection不得跨边界。profile、Workspace、build、Web asset root和daemon endpoint都由release composition显式提供。

## 安装、升级、回滚、卸载

安装器只接受显式archive/prefix。prefix不能是filesystem root、用户home、repo root、symlink/reparse point或未标记的非空目录。
每个candidate物化到immutable `releases/<candidateId>`；stable launcher、唯一`active` pointer、managed marker、`.candidate-id`
与manifest/checksum交叉验证。

upgrade/rollback只验证target candidate并原子切换pointer；已运行进程固定自己的candidate root，不重读pointer。安装器不discover、stop、
replace或upgrade任何App Server，也不获取Runtime lifecycle fence。切换只影响下一次paired App Server或daemon start。

uninstall先完整枚举并校验managed tree；unknown file/directory/link立即拒绝。校验通过后删除managed install root，但不发送进程控制命令。
运行中的daemon可能继续持有已加载代码，用户应在卸载前显式`kite server stop`；卸载器不会用旧`service *`命令猜测或强杀进程。

## Stable launcher

stable launcher验证active pointer、candidate identity和target executable后透明转发argv/env。Service executable只接受
`app-server run-stdio|run-daemon`、MCP wrapper及process-tree private marker；旧`service run-single`与manager-owned readiness fd已删除。
MCP wrapper仍保持authenticated framing与candidate pinning。

## Platform qualification

Windows candidate额外包含pinned sandbox runner、manifest和vendored runtime。build固定Rust toolchain、`rust-lld`与path remap；
workflow在打包前验证committed runner evidence。Windows job在candidate build前运行owner-only endpoint lifecycle、
`kite-session.sqlite` initialization/execution fencing/mutation和daemon真实process tests。
Release installer contract test在Windows使用pinned Rust冷编译native CLI/launcher fixture；两个fixture并行构建，Windows test budget为120秒，
只吸收hosted runner冷工具链成本，不减少manifest、install、upgrade、rollback或uninstall断言。

`release:smoke`覆盖verify、install、CLI help/version、installed TUI PTY、paired App Server、显式daemon start/status/Web/stop、
retired slot absence、Web payload、MCP wrapper、upgrade、active pointer、immutable roots、rollback与uninstall。单平台smoke不等于G1。

当前代码提交只有macOS本机证据时，macOS/Ubuntu/Windows hosted状态必须保持pending；包含该提交的workflow run通过后才能更新为完成。
