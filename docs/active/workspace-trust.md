# Workspace 信任门禁 / Workspace Trust Gate

状态：active
读取时机：修改 TUI 启动流程（`TuiBootstrap`）、CLI 入口（`apps/kite-cli/src/cli/index.ts`）、workspace 信任存储、`apps/kite-service/src/config/workspace-trust.ts`、`WorkspaceTrustGate.tsx` 或测试 harness 的信任旁路时
验证：`bun test apps/kite-service/test/workspace-trust.test.ts apps/kite-service/test/isolated/cli-workspace-trust.test.ts tests/integration/docs-space.test.ts`、`bun run test:tui:system workspace-trust`

## 概述

TUI首次打开未信任目录时显示workspace授权确认。启动是严格two-phase：Native connector先用access token只准备
no-secret App Control，`TuiBootstrap`通过discovery client查询safe trust snapshot并在需要时提交revision CAS decision；
只有authoritative Service返回trusted完整identity后，Client才请求Workspace-bound one-shot ticket、执行Runtime
initialize并挂载FirstRunFlow或`TuiApp`。未通过门禁时不会创建会话、连接MCP、扫描skill或发起模型调用。TUI只负责
prompt/Exit UX，不直接读取或写入trust store；Service App Control owner重新canonicalize路径、校验完整Workspace
identity并执行CAS。conflict或lost response后只query一次，不自动重放decision。CLI`run/resume`使用同一顺序，
`--trust-workspace`只是显式decision，不绕过Service owner。

Workspace Trust同时拥有Workspace关联的external-read scope授权。Service在query时canonicalize所有位于Workspace外、
但Runtime正确读取repository所需的roots（当前包括Git`gitDir/commondir`），把排序roots与scope digest作为safe DTO返回。
TUI必须在同一个Trust Gate内显示这些exact paths；decision同时回传scope digest并受revision CAS约束。这个判断位于
Workspace scope层，不检查`git log`、Shell或其他具体命令名称。未确认时Native Runtime transport保持关闭，批准后
Service才把exact roots只读投影给native sandbox；root新增、移除或canonical identity改变都会让已有trust变回unknown。
pre-trust discovery只读取有界4 KiB、普通非symlink的Git identity files；超限、symlink metadata file或无法解析的
identity不产生外部授权，也不读取repository正文、config、objects或refs。

`apps/kite-cli/src/tui/index.tsx` 中的主应用 action 路由（包括会话切换、Rewind 和其他 Overlay 操作）
全部位于 `TuiApp` 内，只能在 `TuiBootstrap` 已通过 workspace 信任检查后挂载。
修改这些 action 接线不得把会话存储、RuntimeStore 或工具初始化上移到信任分支之前。

真实trust store、query/decision handler、connect admission与per-connection Runtime authorization都由
`apps/kite-service`唯一composition拥有。carrier对带Workspace的App request重新解析并比较完整identity；query/
decision/connect body、cwd、clientInfo与display name本身都不提升authority。`apps/kite-cli`没有trust repository或
fallback writer，只保存语言、theme等UI-local preference。

## 判定流程（`shouldPromptWorkspaceTrust`）

1. canonicalize Workspace并解析关联external-read roots，形成`externalReadScopeDigest`。
2. 读取`workspaceTrustPath()`；`workspaceKey = canonicalWorkspaceKey(workspace)`命中且记录的scope digest与当前完全一致 → 放行。旧记录只在当前external roots为空时兼容。
3. 未命中、scope drift（`unknown`）、记录损坏（`corrupt`）或存储不可用（`unavailable`）→ 提示确认。损坏与不可用按fail-closed处理；真实external scope走用户确认而不是伪装成命令或repository错误。

**安全不变量：刻意不提供环境变量旁路。** Bun 在用户代码执行前会自动把 `<cwd>/.env*` 注入 `process.env`，任何 env 开关都能被未信任目录内的攻击者可控文件伪造（恶意仓库提交 `.env` 即可在首次打开时静默放行）。自动化必须走显式背书：CLI `--trust-workspace`（`source: 'config'`）或预写信任存储（测试 harness 用 `source: 'test'`）。新增门禁逻辑时不得重新引入 env 判定，回归测试覆盖 `.env` 伪造场景（`apps/kite-service/test/isolated/cli-workspace-trust.test.ts`、`tests/tui-system/scenarios/workspace-trust.test.ts`）。

## 确认界面（`apps/kite-cli/src/tui/components/WorkspaceTrustGate.tsx`）

- 展示目录绝对路径与信任后果说明（加载项目配置/skills/MCP、agent 可执行 shell 与修改文件）。
- external-read roots非空时逐项展示canonical path，并明确它们只获得读取权限；这些路径来自Service safe snapshot，
  TUI不自行解析`.git`或其他Workspace内容。
- 选项为“信任此工作区并继续”与“退出 Kite Code”（实际文字随当前 TUI locale 本地化）；↑↓ 选择，Enter 确认，Esc 与 Ctrl+C 退出。
- **默认焦点在 "Exit Kite Code"**，防止用户习惯性按 Enter 直接授权。
- 选择信任 → 通过App Control decision codec提交observed status与expected revision；actual owner调用trust store写入并
  返回canonical snapshot。写入失败时在界面内显示错误（`store_corrupt` / `store_unavailable`），用户可显式重试或退出。
- 选择拒绝或按 Esc → 进程退出，不写入任何状态。

## CLI 入口（`apps/kite-cli/src/cli/index.ts`）

`run` 命令在加载配置与创建 Runtime 之前执行同一 `shouldPromptWorkspaceTrust` 判定：

- 未信任且未显式授权 → 向 stderr 输出错误并以非零码退出，stdout 不产生任何 runtime 事件（stdout 保持 JSONL 事件流语义）。
- `--trust-workspace` → 调用方显式背书，写入 `source: 'config'` 的信任记录后继续；该记录只表示 Workspace trust，
  不授予 Full 或任何 approval grant。历史 `--full-access` flag 仅保留为 ignored/negative compatibility input，
  不再是当前 CLI authority（见 `docs/active/authorization.md`）。记录写入失败时同样报错退出。CI/自动化应使用该旗标或预写信任存储。
- Runtime Server core只接受Service为每个logical connection绑定的独立已信任canonical Workspace；create只使用该
  binding，resume/query/fork使用persisted Session identity并fail closed校验。terminal client、RPC params、session
  display name或任意绝对路径都不能提升Workspace authority，trust也不会提升为Full或approval grant。
- `trace`、`help` 命令不执行项目代码，不做门禁。

Service composition产生的sandbox诊断也只能写入Service stderr/受限diagnostic surface；不得混入terminal CLI stdout，
更不得由TUI把该内部诊断直接投影为对话内容。

## 存储格式

`workspaceTrustPath()` = `<codeRoot>/workspace-trust.jsonc`；managed Service 的 `KITE_CODE_HOME` 只接受
release/manager 注入的 exact validated code root，不是 Workspace 或 ambient OS-home override：

```jsonc
{
  "version": 1,
  "records": {
    "<workspaceKey>": {
      "workspaceKey": "<workspaceKey>",
      "workspacePath": "/absolute/path/at/trust/time",
      "trustedAt": "2026-07-27T00:00:00.000Z",
      "source": "user",
      "externalReadScopeDigest": "sha256:<scope>"
    }
  }
}
```

- map key 必须等于记录的 `workspaceKey`，`records` 必须是对象（数组等形式判 `corrupt`），否则整个存储视为损坏（防手工篡改误放）。
- `workspacePath` 仅供审计，不参与判定；目录移动或改名后 key 变化，信任自然失效。
- `externalReadScopeDigest`绑定批准时展示的exact roots；缺少该字段的legacy record只对空external scope有效，scope
  新增或漂移必须重新确认。roots本身由每次query重新canonicalize，不从store反向恢复authority。
- 写入使用 fsync + 原子 rename，文件权限 0o600，与 MCP 项目批准存储同一模式。`trustWorkspace()` 在读取-合并-写入前获取 `.lock` 文件（排他创建 + 指数退避重试，5s 过期清理残留锁），并在持锁后重新读取存储，避免多进程并发信任不同目录时发生记录覆盖。
- `source` 当前取值：`user`（TUI 确认）、`config`（CLI `--trust-workspace` 显式背书）、`test`（测试 harness 预写）。

## 测试边界

- `spawnTui()` 默认为启动目录预写一条 `source: 'test'` 的信任记录（存入临时 home 的信任存储），现有 PTY 场景走与生产一致的"已信任目录"快速路径，不受门禁阻塞。不使用 env 旁路（见上文安全不变量）。
- 验证门禁本身时使用 `createTestWorkspace({ enforceWorkspaceTrust: true })` 跳过预写，参考 `tests/tui-system/scenarios/workspace-trust.test.ts`：门禁渲染与阻断、信任持久化并启动、已信任目录重启跳过、拒绝后干净退出且无持久化；场景同时在 workspace 放置伪造 `.env`，验证 Bun dotenv 注入不能绕过门禁。
- CLI/Service门禁由`apps/kite-service/test/isolated/cli-workspace-trust.test.ts`及CLI client tests覆盖：验证拒绝路径
  （无stdout泄漏、无Runtime initialize）、`--trust-workspace`记录`source: 'config'`、`.env`伪造旁路被拒、已信任
  目录免旗标放行与Trust通过前只有App Control preparation。

## 边界与现状

- TUI与CLI`run/resume`都通过managed Native Service执行two-phase门禁。Service-owned internal stdio只给拥有child
  lifecycle的Desktop/test父进程，不是terminal fallback；development/reference loopback WebSocket也不能绕过Trust，
  但不是production Web/Desktop入口。
- workspace 信任是canonical目录及其exact external-read scope的一次性决定，不是逐命令或逐工具授权；工具级授权仍由 `docs/active/authorization.md` 与 approval policy 管理，项目 MCP 来源仍单独受 `docs/active/mcp-project-approval.md` 门禁约束。
- workspace 信任同时授权 Agent 将其已读取的任意仓库内容用于后续模型上下文。模型调用不会另设正文准入、分类或阻断；敏感内容仍不得进入 Runtime Event、telemetry 或 session metadata；写入、shell、网络、MCP write 等副作用继续受各自的授权与执行边界约束。
- 门禁求值前只读取惰性配置（JSONC 解析，不执行项目代码）；skill 扫描、MCP 连接与 shell 执行全部发生在门禁通过之后。
- 通过门禁后才挂载的 `TuiApp` 可将 workspace 传给会话 Header 作为展示快照；该传递不得改变门禁判定顺序，亦不得在未信任分支挂载 Header 或读取会话状态。
