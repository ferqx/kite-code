# Kite Local Runtime Service V1 事实与依赖基线

日期：2026-08-27

用途：KLSV1-00 的实现前事实快照与 client dependency 决策清单。此文件不授权 production 行为，不替代 workspace
README、`docs/active/` 或实现时的 documentation-impact 判断。

相关：ADR-0144、[`Kite Local Runtime Service V1 实施方案`](../plans/2026-08-27-kite-local-runtime-service-v1.md)、
ADR-0053、ADR-0129、ADR-0139、ADR-0142、ADR-0143。

## 当前 production 事实

1. `apps/kite/src/bootstrap.ts` 是唯一 concrete Runtime composition root，并在一个前台进程中创建 SQLite Store、
   Runtime Host、Builtin modules、Runtime Server/Client、History adapter 与 TUI/CLI bridge。
2. TUI 与 foreground CLI 已经统一经过 `RuntimeClient → RuntimeServer → RuntimeAccess`，但 carrier 是同进程组合；
   `kite server --stdio` 仍是 parent-owned child，loopback WebSocket 仍只用于 development/reference。
3. `createKiteRuntimeServerComposition()` 的 admission 固定返回 bootstrap `workspace`。Protocol `create_session` 没有
   Workspace 字段，App mapper 才注入 admission Workspace。
4. `RuntimeHistoryClient` 由 App 在同进程注入，完整 durable history 已经走 SQLite readonly reader 与 safe projector；
   外部 Runtime WebSocket 本身没有完整 History transport。
5. TUI 启动仍直接创建 `SessionManager`、Config、Workspace Trust、Provider/model、MCP、Skill、sandbox、Git、
   observability 与 Runtime dependencies；退出仍会 `abortAll()` 并 dispose 当前 Host composition。
6. current writer 是 State 27 / Store 6 / `kite-runtime-server-v1-2026-08-26`。KLSV1 不增加表、State、epoch、
   Host fencing、persisted Project 或 Kernel service event。
7. `apps/kite` 当前有 455 个 tracked 文件，其中 261 个 production `src` 文件、186 个 owner-local tests、5 个
   owner-local docs，以及 README/package/tsconfig。完整 relocation 覆盖见同日期 relocation manifest。

## 目标 owner 与生命周期分类

| 分类 | 唯一目标 owner | 当前对象/调用 | 不得越界 |
| --- | --- | --- | --- |
| terminal/UI-local | `apps/kite-cli` | React/Ink reducer、overlay、locale、theme、terminal focus/key handling、当前 foreground selection、Trace presentation | Runtime Host/Server/SQLite/Builtin executor、Manager、credential material |
| Runtime command/query/event | 现有 `runtime-contract` / `runtime-client`，由 `apps/kite-cli` 消费 | create/resume/start/cancel/delete/rewind/fork/compact/mode/interaction、projection/subscription | Workspace path authority、callback、AbortController、Store handle |
| 完整 durable history | Service-owned raw projector + existing safe History DTO；CLI-only facade | list sessions、list events、load complete transcript、TUI replay/recovery display | raw RuntimeEvent、SQLite path/handle、notification fallback |
| 无 secret App Control | `kite-app-contract` DTO/codec + `apps/kite-service` handler | Workspace Trust、Provider/model projection、MCP snapshot/action、Skill catalog/status、execution/release status | Manager object、dynamic method、raw API key/OAuth credential |
| Native secret/lifecycle | `kite-local-runtime` exact codec + `apps/kite-service` handler | raw Provider credential write、MCP OAuth material、descriptor、ensure/status/stop/restart | Browser/renderer import、automatic mutation retry、Runtime Protocol |
| Runtime implementation | `apps/kite-service` | Store/Host/Server/Builtin、config repositories、CredentialBroker、MCP Supervisor、Skill scan、sandbox/Git、session logging、raw projector | Ink/React/TUI reducer、app-to-app import |

对象 lifecycle 固定为：

| 生命周期 | 对象 |
| --- | --- |
| process-wide | default Store、Runtime Host/Server、user config repository、CredentialBroker、Service auth/state、release identity |
| per-Workspace | project config、Skill scan/catalog、MCP supervisor/catalog/watch、sandbox/filesystem、Git broker、model route/context |
| per-Session | Runtime Session、interaction broker waiter、projection、selected model/mode、recovery identity |
| per-Client | Native connection、Runtime subscriptions、History/App snapshot generation、TUI foreground selection |

任何 project-dependent API 都必须接收 explicit canonical Workspace；不存在 process-global mutable “current
Workspace”。Provider 未配置时 neutral Service boot 仍必须 ready，只有需要 Model 的 operation fail closed。

## TUI direct dependency / use-case manifest

| 当前 direct dependency | 当前入口 | 迁移 use case | 目标边界 |
| --- | --- | --- | --- |
| Workspace Trust store | `TuiBootstrap`、CLI `run/server --stdio` | query candidate、record explicit decision、connect 时 revalidate | browser-safe exact App Control；CLI 保留提示和 `--trust-workspace` |
| user/project config | `config/index.ts` 与 TUI bootstrap | provider/model/config snapshot，project-scoped resolve | Service App Control + per-Workspace runtime context |
| raw Provider credential | first-run forms / config mutation | write/delete exact credential、随后 query readiness | native-only secret command；body 不记录、不自动 retry |
| model selection | setup/model selector、`setSessionConfig` | list available route、select model、read selected route | safe App Control + Runtime session command/projection |
| MCP Supervisor/config/auth | `useMcpController`、`TuiMcpController` | list/detail/add/remove/enable/disable/approve/auth/retry | safe App Control snapshot/action；OAuth/credential material native-only |
| Skill scanner/catalog | `useSkillsLoader` | list compiled manifests/status for admitted Workspace | Service App Control projection；Runtime execution keeps actual manifests |
| sandbox/Git/filesystem | bootstrap/session runtime | authoritative availability/status and Runtime effect execution | status projection via App Control；mechanism only in Service |
| release/execution status | App release/config projection | show effective status/limitation | safe App Control projection |
| SessionManager/SessionRuntime | TUI hooks/App | session lifecycle, run/cancel/wait, projection, interaction | `TuiRuntimeClientFacade`; no object/callback passthrough |
| token stats/naming | SessionManager local Store calls | get context status、session name mutation/projection | Runtime/App Control exact use case；no direct Store |
| complete history | `createTuiHistoryFacade` | list/load/replay/recovery display | authenticated local History client |
| local UI state | reducer/provider/overlay/focus | selection, render, input normalization, locale/theme | stays in `apps/kite-cli` |

The current `TuiSessionManagerDependencies` still passes `AgentConfig`、`SessionUserInputProvider`、Skill manifests/options、
MCP provider/recovery controller、checkpoint path 与 shell executor into the TUI factory. KLSV1-03 must replace this
dependency object with typed Runtime/History/App Control clients before transport cutover; it cannot serialize this object.

## SessionManager / SessionRuntime method migration

| 当前方法组 | 当前调用语义 | 新 client API / owner |
| --- | --- | --- |
| `createSession`、`registerSession`、`waitForSessionReady` | create/resume + recovery admission | Runtime command + projection/subscription readiness；create Workspace 来自 connection admission |
| `listPersistedSessions`、`loadPersistedSession` | full persisted discovery/replay | History `listSessions` / `loadSession`；CLI-only safe facade |
| `deletePersistedSession`、`removeRuntime` | durable delete/close + local registry cleanup | Runtime `delete_session`/`close_session` command；Client local subscription cleanup |
| `getRuntime().runTask`、`tryReservePrompt` | start foreground turn | Runtime `start_turn` command；Service execution bridge owns actual run |
| `getRuntime().abort`、`cancelRuntimeOperations`、`abortAll` | local signal + durable cancel | explicit Runtime `cancel_turn`; client exit never maps to cancel-all |
| `waitForRunCompletion`、`waitForManualCompactionCompletion` | await local execution object | projection/subscription terminal wait keyed by session/operation identity |
| `getRuntime().resolveInterrupt` | frontend waiter settlement | Runtime `respond_interaction`; Service interaction broker resolves from durable identity |
| `setForeground`、`switchSession`、`getActiveId` | presentation selection | CLI-local state + subscribe/unsubscribe; no Runtime cancellation |
| `getSnapshot`、`getSessionProjection`、`buildContextStatusSnapshot` | mixed local/Host projection | Runtime queries/subscriptions + exact App status projection |
| `conversationHistory`、`eventBuffer`、token fields | local mutable presentation/history | History client + RuntimeClient generation store + TUI reducer |
| `listRewindCheckpoints`、`previewRewind`、`executeRewind` | checkpoint query/command | existing Runtime query/command |
| `handleContextCompaction`、`handleContextReset`、planning methods | compact/reset/mode mutation | existing Runtime command/query/projection |
| `setSessionConfig`、`getDefaultConfig` | model route/config mutation | App Control model/config use case + Runtime selected-model projection |
| `updateSkillManifests`、`updateMcpRuntimeProvider`、`updateMcpRecoveryController` | inject live Manager/provider objects | removed from client facade；Service per-Workspace owner only |
| `saveTokenStats`、`generateAndPersistSessionName`、`setName` | direct metadata persistence | exact Runtime/App Control mutation/projection；no Store access |
| `recoverRuntimeState`、host compaction/rewind committed intent helpers | Host execution/recovery internals | Service-owned Runtime Application bridge；not client API |
| `dispose`、coordinator close、observability shutdown | destroy current composition | Service lifecycle only；CLI dispose closes clients/subscriptions |

`SessionRuntime`、`SessionManager`、`SessionUserInputProvider`、callback、iterator、AbortController、Manager 与 Store
handle 均不跨 client seam。fake clients must cover each current TUI journey before KLSV1-06 cutover.

## History relocation baseline

| 当前文件 | target | 原因 |
| --- | --- | --- |
| `bootstrap/runtime/state-runtime.ts` | `apps/kite-service` | raw Runtime Event/State authority |
| `runtime-client/event-projector.ts` | `apps/kite-service` | raw-to-safe exhaustive projection |
| `runtime-client/interaction-projector.ts` | `apps/kite-service` | raw interaction State/effect projection |
| `runtime-client/history-adapter.ts` | `apps/kite-service` | SQLite log query adapter |
| `runtime-client/presentation-history.ts` | `apps/kite-service` | raw durable event to safe client event projection |
| `logs/runtime-log-presentation.ts` | `apps/kite-service` | raw log presentation projection |
| `runtime-client/safe-text.ts` | `apps/kite-service` | raw projector sanitization primitive |
| `runtime-client/tui-history-facade.ts` | `apps/kite-cli` | only consumes safe `RuntimeHistoryClient` DTO |
| `session-types.ts`、TUI reducers/replay | `apps/kite-cli` | safe presentation state only |

不得把 raw event package 化、复制第二份 projector、让 Service import CLI source，或让 CLI 直接读取 SQLite。

## production environment key baseline

当前 production source reads are the implementation baseline; the resident child allowlist must be narrower than ambient
`process.env` and must keep the same supported Provider behavior.

| key / family | 当前读取位置与用途 | Service child rule |
| --- | --- | --- |
| `KITE_CODE_HOME` | App/Builtin path resolvers choose user state root | only explicit validated home identity；do not trust cwd-loaded ambient value |
| `${PROVIDER}_API_KEY` | `config/index.ts` Provider key fallback | explicitly enumerate resolved current provider key for Service startup；never log |
| `${PROVIDER}_BASE_URL` | `config/index.ts` Provider endpoint fallback | explicitly enumerate resolved current provider URL |
| MCP `${VAR}` config expansion | `mcp-server-config.ts` reads declared names | resolve only after admitted Workspace and only declared exact names |
| `PATH` | executable/sandbox/MCP/Git lookup | explicit system allowlist value |
| `HOME` / `USERPROFILE` | OS home, sandbox and child runtime | canonical OS identity; not Workspace override |
| `SHELL` / `COMSPEC` / `PATHEXT` | shell selection | explicit platform allowlist |
| `SystemRoot` / `SYSTEMROOT` / `WINDIR` | Windows system executables and keyring | explicit platform allowlist |
| `TMPDIR` / `TMP` / `TEMP` | temporary runtime | explicit platform allowlist |
| `LANG` / `LC_ALL` | child locale | explicit optional allowlist |
| `APPDATA` / `LOCALAPPDATA` / `PROGRAMDATA` | Windows current-user runtime | explicit platform allowlist |
| `XDG_CACHE_HOME` / `BUN_INSTALL_CACHE_DIR` | existing user/runtime caches where currently consumed | include only if source-run/installed evidence proves required |
| `KITE_STANDALONE_EXECUTABLE` | Runtime Host child executable selection；release build inlines `1` | managed build identity only；not caller override |
| `KITE_WINDOWS_RUNNER_PATH` | development Windows runner override | do not inherit in installed Service；explicit test/development injection only |
| `NODE_ENV` | production/test branching | fixed build/runtime value；not copied from Workspace |
| `USERDOMAIN` / `USERNAME` / `USER` | session logger owner diagnostics | derive from OS/current process only；do not publish in descriptor |

Test/qualification-only families such as `KITE_TEST_*`、`KITE_RUN_*`、`KITE_FAULT_*`、`KITE_TUI_*`、
`KITE_WORKSPACE_FILESYSTEM_TEST_HOOKS` must never be inherited by production Service. `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`
and credential/askpass/SSH variables are not general Service env; network/Git/MCP components retain their existing exact
sanitizers and capability-specific input.

The child cwd is an owner-only empty directory under the validated service root. It must reject `.env*`、`bunfig*`、loader
or preload files and must not be the requested Workspace or the ordinary user config directory.

## client contract/build identity baseline

- Runtime Protocol stays exact V1; no `runtime/service/*` method and no build/process field is added to initialize.
- Local client contract uses one fixed V1 revision shared by `kite-app-contract` codecs and native History/App/lifecycle codecs.
- installed `buildId` is the managed candidate manifest ID; source run uses `dev:<40-hex-git-commit>`.
- descriptor publishes instance ID, PID, start time, loopback origin/WS URL, Protocol version, client contract revision,
  server version and build ID only.
- access/control token、Workspace、Store/executable path、credential and Session data are forbidden descriptor fields.

## release/internal entrypoint baseline

Current candidate build has two standalone entrypoints, `scripts/release/entrypoints/cli.ts` and `tui.ts`, and payload names
`bin/kite`、`bin/kite-tui`. `scripts/release/oss-candidate.ts` has a private workspace resolver for all public exports and a
standalone `#app/*` resolver. Runtime Host internal child modes currently include stdio composition, MCP stdio wrapper and POSIX
supervisor child selection. KLSV1-06/07 must add manifest-managed `kite-service` and move every Host-owned internal mode to that
companion without changing public `kite`/`kite-tui` names.

Standalone keyring remains method-level `unavailable`; Service startup itself must stay ready. This limitation is not an installed
credential success Gate and must not be bypassed by file/env plaintext fallback.

## 已确认偏差与 implementation stop conditions

1. `runtime/session/runtime-session.ts` still says “Store 4 production constructor”; current authority is Store 6. Correct the
   comment when relocating the owner; do not infer a Store migration.
2. `documentation-map.json` rejects source bases and authorities that do not exist. KLSV1-00 therefore cannot add future
   `apps/kite-cli`、`apps/kite-service` or `packages/kite-*` rules without creating production workspaces early. The path/owner
   matrix is frozen in the integration manifest; map rules land atomically in KLSV1-01/02/04 when each source/README exists.
3. Existing active docs correctly describe the pre-cutover `apps/kite`/InProcess topology. They must change with the matching
   implementation Task, not during KLSV1-00. Root README changes only when the user-visible default changes.
4. If current Provider/MCP behavior cannot run under the explicit child allowlist, KLSV1-06 default cutover is blocked. Ambient
   `{ ...process.env }` is not an allowed fallback.
5. If any CLI/TUI journey still requires a live Manager/SessionRuntime object after the fake-client facade Gate, transport cutover
   is blocked; do not add a generic App RPC to hide the gap.
