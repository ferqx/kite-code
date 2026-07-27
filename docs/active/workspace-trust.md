# Workspace 信任门禁 / Workspace Trust Gate

状态：active
读取时机：修改 TUI 启动流程（`TuiBootstrap`）、CLI 入口（`src/app/cli/index.ts`）、workspace 信任存储、`src/core/config/workspace-trust.ts`、`WorkspaceTrustGate.tsx` 或测试 harness 的信任旁路时
验证：`bun test tests/workspace-trust.test.ts tests/cli-workspace-trust.test.ts tests/docs-space.test.ts`、`bun run test:tui:system workspace-trust`

## 概述

TUI 首次打开未信任目录时显示 workspace 授权确认，逻辑类似 VS Code 打开新项目时的 "Do you trust the authors of the files in this folder?"。门禁在 `TuiBootstrap` 中同步求值，并先于 SetupWizard 与 `TuiApp` 挂载：未通过门禁时不会创建会话、连接 MCP、扫描 skill 或发起模型调用。CLI `run` 命令执行同一门禁（见下文 CLI 入口），共享同一用户级信任存储。

## 判定流程（`shouldPromptWorkspaceTrust`）

1. 读取 `workspaceTrustPath()` 存储，`workspaceKey = canonicalWorkspaceKey(workspace)`（canonical realpath 的 sha256，与 MCP 项目批准复用同一摘要函数）命中记录 → 放行。
2. 未命中（`unknown`）、记录损坏（`corrupt`）或存储不可用（`unavailable`）→ 提示确认（TUI 显示界面 / CLI 拒绝运行）。损坏与不可用按 fail-closed 处理：要求用户重新确认，而不是静默放行。

**安全不变量：刻意不提供环境变量旁路。** Bun 在用户代码执行前会自动把 `<cwd>/.env*` 注入 `process.env`，任何 env 开关都能被未信任目录内的攻击者可控文件伪造（恶意仓库提交 `.env` 即可在首次打开时静默放行）。自动化必须走显式背书：CLI `--trust-workspace`（`source: 'config'`）或预写信任存储（测试 harness 用 `source: 'test'`）。新增门禁逻辑时不得重新引入 env 判定，回归测试覆盖 `.env` 伪造场景（`tests/cli-workspace-trust.test.ts`、`tests/tui-system/scenarios/workspace-trust.test.ts`）。

## 确认界面（`src/app/tui/components/WorkspaceTrustGate.tsx`）

- 展示目录绝对路径与信任后果说明（加载项目配置/skills/MCP、agent 可执行 shell 与修改文件）。
- 选项："Yes, I trust the authors" / "No, exit"；↑↓ 选择，Enter 确认，Esc 与 Ctrl+C 退出。
- 选择信任 → `trustWorkspace()` 写入记录后挂载主界面；写入失败时在界面内显示错误（`store_corrupt` / `store_unavailable`），用户可重试或退出。
- 选择拒绝或按 Esc → 进程退出，不写入任何状态。

## CLI 入口（`src/app/cli/index.ts`）

`run` 命令在加载配置与创建 Runtime 之前执行同一 `shouldPromptWorkspaceTrust` 判定：

- 未信任且未显式授权 → 向 stderr 输出错误并以非零码退出，stdout 不产生任何 runtime 事件（stdout 保持 JSONL 事件流语义）。
- `--trust-workspace` → 调用方显式背书，写入 `source: 'config'` 的信任记录后继续；语义与 `--full-access` 的 `source: 'config'` 授权一致（见 `docs/active/authorization.md`）。记录写入失败时同样报错退出。CI/自动化应使用该旗标或预写信任存储。
- `trace`、`help` 命令不执行项目代码，不做门禁。

## 存储格式

`workspaceTrustPath()` = `~/.kite-code/workspace-trust.jsonc`（`KITE_CODE_HOME` 可覆盖 home 根目录）：

```jsonc
{
  "version": 1,
  "records": {
    "<workspaceKey>": {
      "workspaceKey": "<workspaceKey>",
      "workspacePath": "/absolute/path/at/trust/time",
      "trustedAt": "2026-07-27T00:00:00.000Z",
      "source": "user"
    }
  }
}
```

- map key 必须等于记录的 `workspaceKey`，`records` 必须是对象（数组等形式判 `corrupt`），否则整个存储视为损坏（防手工篡改误放）。
- `workspacePath` 仅供审计，不参与判定；目录移动或改名后 key 变化，信任自然失效。
- 写入使用 fsync + 原子 rename，文件权限 0o600，与 MCP 项目批准存储同一模式。读写为 last-writer-wins，无跨进程锁：并发信任不同目录时后写覆盖先写，被丢记录的方向是 fail-closed（下次重新提示），与 MCP 项目批准存储同一语义。
- `source` 当前取值：`user`（TUI 确认）、`config`（CLI `--trust-workspace` 显式背书）、`test`（测试 harness 预写）。

## 测试边界

- `spawnTui()` 默认为启动目录预写一条 `source: 'test'` 的信任记录（存入临时 home 的信任存储），现有 PTY 场景走与生产一致的"已信任目录"快速路径，不受门禁阻塞。不使用 env 旁路（见上文安全不变量）。
- 验证门禁本身时使用 `createTestWorkspace({ enforceWorkspaceTrust: true })` 跳过预写，参考 `tests/tui-system/scenarios/workspace-trust.test.ts`：门禁渲染与阻断、信任持久化并启动、已信任目录重启跳过、拒绝后干净退出且无持久化；场景同时在 workspace 放置伪造 `.env`，验证 Bun dotenv 注入不能绕过门禁。
- CLI 门禁由 `tests/cli-workspace-trust.test.ts` 覆盖：真实 spawn CLI 入口，验证拒绝路径（无 stdout 泄漏、无持久化）、`--trust-workspace` 记录 `source: 'config'`、`.env` 伪造旁路被拒、已信任目录免旗标放行。

## 边界与现状

- TUI 与 CLI `run` 均执行门禁；web 前端当前不做 workspace 信任检查。
- workspace 信任是目录级一次性决定，不是逐工具授权；工具级授权仍由 `docs/active/authorization.md` 与 approval policy 管理，项目 MCP 来源仍单独受 `docs/active/mcp-project-approval.md` 门禁约束。
- 门禁求值前只读取惰性配置（JSONC 解析，不执行项目代码）；skill 扫描、MCP 连接与 shell 执行全部发生在门禁通过之后。
- 信任存储写入使用 lock 文件防并发：`trustWorkspace()` 在读取-合并-写入前获取 `.lock` 文件（排他创建 + 指数退避重试，5s 过期清理残留锁），消除多进程并发写入覆盖风险。
