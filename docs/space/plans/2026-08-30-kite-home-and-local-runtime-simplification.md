# Kite Home 与本机 Runtime 单一化实施方案

状态：active

日期：2026-08-30

优先级：P0

相关：ADR-0152、ADR-0153、ADR-0154。

## 1. 目标

```text
TUI / CLI / native client
          │ Unix socket / named pipe
          ▼
┌──────────────────────────────────────┐
│ Kite Local Service                   │
│ Runtime / Controller / Agent API     │
│ Browser Observer routes              │
└──────────────────────────────────────┘
          │
          └── ~/.kite-code/kite.sqlite

OS runtime: service endpoint + lifecycle reservation
```

Kite Home白名单：

```text
~/.kite-code/
  kite-code.jsonc
  mcp.json
  mcp-project-approvals.jsonc
  workspace-trust.jsonc
  skills/
  sessions/
  kite.sqlite
  kite.sqlite-wal
  kite.sqlite-shm
```

每个canonical Kite Home只有一个Service、一个Runtime Host、一个SQLite writer和一个loopback HTTP listener。不同custom home是独立
profile，不建立跨home coordination。Browser和Vite dev server不拥有本机Service lifecycle。

## 2. Store 9

Store 9使用一个connection和固定19-table/5-index schema：

- `kite_meta`只保存current schema/format及现有Controller/recovery namespace；
- `workspaces`与Runtime Session/event/snapshot/preimage/effect/command receipt/Run/tombstone表保存current Runtime事实；
- Model、Plan、Capability、filesystem mutation preimage、Sandbox preparation、Subagent task/lifecycle/continuation各自使用typed表；
- Directory直接查询同一DB，不复制Catalog mirror或outbox；
- writer直接使用`BEGIN IMMEDIATE`，不增加global queue、migration phase、first-write marker或无消费者的Service operation receipt。

Artifact表继续保留各自schema、digest、byte bound、reader与GC；单数据库不等于generic blob表。Kernel只看path-free ref，不依赖SQLite。

## 3. Service与Web

- `run/resume`、TUI与`service *`通过按home digest隔离的native endpoint ensure同一Service。
- POSIX runtime只有`service.sock`与`service.lock`；Windows只有SID/home-digest绑定的named pipe。
- manager使用PID+process start identity确认owner；只有exact dead owner才清理匹配endpoint/reservation。
- `kite web`在任何lifecycle和auth状态前验证static root、`index.html`、OpenAPI与hashed JS/CSS。缺失返回
  `web_assets_missing`且不spawn、不创建DB/socket/token。
- `web_ensure`attach同一HTTP listener并mint一次性URL；`web_status`只读返回state/origin/asset digest；`web_stop`只撤销Browser状态。
- Agent API、Browser cookie/ticket与native credential保持route/auth隔离；Browser永远没有Controller或mutation route。

## 4. Clean cutover

Kite Code仍处于未发布阶段，执行ADR-0128/0154 clean cutover：

- 正式CLI/candidate不提供Store 7/8 migration、legacy `web recover`或Coordinator/Worker/Gateway release entrypoint；
- normal Service不扫描、读取、迁移或删除旧DB/layout/Artifact/process state及`~/.kite-code-coordination`；
- 旧开发数据保持原样但不是current fallback；确需保留时由开发者在明确授权下单独备份，当前不预建兼容工具；
- release只包含`kite`、`kite-tui`、`kite-service`和Web/docs/launcher assets。

## 5. 实施状态

| Task | 状态 | 产出 | 验证 |
| --- | --- | --- | --- |
| `KHSS-01` | completed | Store 9 current schema、typed Artifact backend、单writer transaction | Store/Workspace/Artifact/RuntimeStorage tests |
| `KHSS-02` | completed | 单Service native IPC、统一HTTP/Web route、CLI/TUI/Web client | manager/client/real-child/Web tests |
| `KHSS-03` | completed | clean cutover：删除legacy release/migration/cleanup与无消费者DB状态 | release inventory、CLI、Store exact schema tests |
| `KHSS-04` | in_progress | current docs、candidate与三平台qualification | docs/architecture gates、build/verify/smoke、hosted matrix |

## 6. 验收标准

- clean first run后Kite Home只命中白名单，OS runtime只命中endpoint/reservation；
- TUI/CLI/Web复用一个Service，release没有retired companion executable/entrypoint/slot；
- `kite.sqlite`可独立backup/reopen，所有current Workspace、Session、Run、receipt、Controller与Artifact事实来自同一connection；
- Web缺asset不产生状态，status不创建launch token，ensure重试不产生第二listener；
- normal startup不访问或删除legacy source；
- `bun run format:check`、`bun run typecheck`、core/runtime/architecture/docs gates、full tests与release build/verify/smoke通过；
- native endpoint、ACL和candidate在真实macOS、Ubuntu、Windows runner验证。

## 7. 停止条件

需要第二Service、第二DB、durable OS state/data root、filesystem Artifact、generic blob、global writer queue、dual write或兼容fallback时停止并
重新评审。每个Task阶段完成前执行`.agents/skills/overengineering-check/SKILL.md`；存在无生产消费者或仅为未发布格式保留的机制时不得标记完成。
