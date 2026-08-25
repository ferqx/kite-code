# SQLite 会话日志 Server/Web 实施方案

状态：active

日期：2026-08-23

优先级：P1

权威来源：用户直接裁决、当前 State 26 / Store 5 SQLite 实现、
[`Kite Code 六概念 Runtime 架构`](../../active/six-concept-runtime-architecture.md)、
[`Private immutable Artifact storage`](../../active/private-artifact-storage.md)。

## 1. 用户裁决与方案边界

本计划固定以下事实，实施时不得重新解释：

1. 所有可回放的会话数据都以 SQLite Runtime Store 为唯一事实源；
2. `runtime_events` 与 current codec 共同形成会话日志，rolling snapshot 只加速恢复，不替代事件日志；
3. 本地 Session Logger、`sessions/*/events.jsonl`、Trace JSONL 与 metadata/content logging 是历史测试或独立诊断设施，不属于 Server/Web 数据源；
4. Web 页面不得通过扫描 Session Logger 目录补齐、覆盖或校验 SQLite；
5. Model/Capability/Filesystem/Sandbox/Subagent 私有 Artifact 仍是独立证据域，不能因“日志页面”而默认展开；
6. 当前 Runtime 不持久化的 ephemeral streaming delta 不属于可回放会话日志，页面不得伪造或宣称能够恢复逐 token 历史。

本计划只建立 SQLite 会话日志的只读服务化能力与本地 Web 展示，不改变 Agent、Kernel、Tool Pipeline、事务、恢复、授权或执行语义。

## 2. 目标

提供一个用户显式启动的本地日志 Server，并打开 Web 页面查看：

- 全部 current-format SQLite 会话的分页列表；
- 单会话完整 durable 事件时间线；
- 用户消息、模型终态、工具、审批、计划、Subagent、恢复、验证及失败诊断的类型化展示；
- 基于 `sessionId + sequence` 的稳定向前/向后分页；
- 会话运行期间的增量刷新和断线续传；
- 当前 revision、最后事件位置、恢复可用性及数据完整性状态；
- 受控的事件详情，不向浏览器暴露 raw SQLite、任意 SQL 或未投影私有 Artifact。

成功标准：Web 首屏和后续分页只读取 SQLite；同一 current-format 会话经既有 Runtime replay 与 Web 日志读取获得相同的事件顺序、类型和事件数量，新增事件不会造成重复或丢页。

## 3. 非目标

- 不建设远程托管日志、云同步、多人账户、组织权限、外部 telemetry 或 OpenTelemetry 后端；
- 不自动随 TUI/CLI 启动常驻 Server；
- 不让浏览器直接打开 SQLite 文件、Session Logger 文件或 Artifact 文件；
- 不提供 Runtime command、审批、取消、恢复、删除会话或工具执行等写操作；
- 不在线迁移旧 Runtime epoch，不为旧格式增加兼容 decoder；
- 不把跨会话事件合并成有严格全局因果顺序的单一流；V1 的全局页面以会话列表为入口，严格顺序只在单会话内保证；
- 不持久化现有 ephemeral model/tool progress 以制造“更完整”的日志；
- 不复用已经失效的 root `src/web-server` 脚本或历史 Session Logger Trace reader。

## 4. 目标架构

```text
Browser
  │  loopback HTTP + SSE，local auth
  ▼
apps/kite local log server
  ├── HTTP DTO validation
  ├── RuntimeLogPresentationProjector
  └── RuntimeLogQueryPort
          │
          ▼
@kite/runtime-storage-sqlite read-only log reader
  ├── current format preflight
  ├── current RuntimeEvent codec
  ├── runtime_sessions cursor query
  └── runtime_events(session_id, sequence) cursor query
          │
          ▼
SQLite Runtime Store（唯一事实源）
```

所有权固定如下：

| 层 | Owner | 职责 | 禁止事项 |
| --- | --- | --- | --- |
| HTTP/Web DTO | `@kite/runtime-contract` | 分页请求、日志投影、错误与完整性 DTO | 不出现 SQLite、Kernel State、Artifact path |
| 查询机制 Port | `@kite/runtime-host/storage` | 定义只读 session/event cursor 语义 | 不解释具体事件业务内容 |
| SQLite Reader | `@kite/runtime-storage-sqlite` | 只读连接、current-format preflight、分页 SQL、codec decode | 不建表、不写 snapshot/event、不返回 raw `event_json` |
| 日志展示投影 | `apps/kite` | RuntimeEvent → Web-safe typed view | 不成为第二 reducer、classifier 或 replay authority |
| Server composition | `apps/kite` | loopback listener、鉴权、路由、SSE、资源生命周期 | 不持有写 Port，不执行 Runtime command |
| Browser UI | `apps/kite` Web surface | 会话列表、过滤、时间线、详情、连接状态 | 不推导 Runtime authority，不直接读取文件 |

`src/core/` 不得依赖 Server 或 Web 类型；Kernel、Builtin 与 Runtime Host 不能导入 HTTP framework。

## 5. 查询契约

### 5.1 会话列表

建议新增 Contract DTO：

```ts
interface ListRuntimeLogSessionsRequest {
  cursor?: { updatedAt: number; sessionId: string };
  limit: number; // 1..100
  query?: string;
}

interface RuntimeLogSessionEntry {
  sessionId: string;
  displayName: string;
  updatedAt: number;
  lastSequence: number;
  lifecycle: 'open' | 'closed' | 'unavailable';
  model?: { provider: string; name: string };
}
```

排序固定为 `updated_at DESC, session_id DESC`；cursor 使用同一二元组。禁止沿用当前默认 50 条、无 cursor 的列表作为 Web 全量查询。名称搜索必须在 SQLite 中有界执行，不能为每个候选会话加载全部事件。

### 5.2 单会话事件页

```ts
interface ListRuntimeLogEventsRequest {
  sessionId: string;
  afterSequence?: number;
  beforeSequence?: number;
  direction: 'forward' | 'backward';
  limit: number; // 1..200
  eventTypes?: readonly string[];
}

interface RuntimeLogEventEntry {
  sessionId: string;
  sequence: number;
  eventId: string;
  causationId?: string;
  occurredAt?: string;
  createdAt: number;
  type: string;
  category: 'session' | 'turn' | 'model' | 'tool' | 'interaction' | 'subagent' | 'verification' | 'recovery' | 'other';
  status: 'ok' | 'running' | 'waiting' | 'cancelled' | 'failed' | 'unknown';
  summary?: string;
  detail?: RuntimeLogEventDetail;
}
```

规则：

- 单会话顺序只由持久化 `sequence` 决定；时间戳仅用于显示；
- `afterSequence` 与 `beforeSequence` 互斥，非法 cursor fail closed；
- decoder 必须使用 current Runtime codec；损坏、旧 epoch 或未知 current event 返回 typed `session_unavailable/corrupt_event`，不得跳过坏行继续伪造完整回放；
- `eventTypes` 必须来自 current discriminant allowlist，禁止拼接 SQL；
- response 必须包含 `nextCursor`、`hasMore` 与读取时观察到的 `lastSequence`；
- 追加并发发生时，既有页保持不变，后续页从精确 sequence 继续。

### 5.3 完整性 DTO

每个页面必须展示而不是隐藏以下状态：

```ts
interface RuntimeLogCompleteness {
  durableEvents: 'complete' | 'unavailable' | 'corrupt';
  ephemeralHistory: 'not_persisted';
  currentFormat: boolean;
  snapshotEventPosition?: number;
  lastEventSequence: number;
  recoveryState?: 'normal' | 'blocked' | 'corrupted';
}
```

页面不能使用 Session Logger 是否存在来计算完整性。

## 6. 展示与隐私边界

Web 本地页面需要展示会话内容，但不能提供通用 `GET raw event_json`：

1. 为 current RuntimeEvent 建立 exhaustive `RuntimeLogPresentationProjector`；
2. 每个 discriminant 显式决定 summary/detail 字段；新增事件未映射时只显示 type 与固定 `detail_unavailable`；
3. 用户消息、模型可见终态和已提交工具结果可进入本地 authenticated session view；reasoning、credential、header、API key 与 Provider 私有 body 永不通过日志 API；
4. 命令、路径、工具参数与 stdout/stderr 按事件类型使用有界长度和结构化字段，不允许任意对象递归透传；
5. HTML 只渲染文本节点或经过固定 Markdown sanitizer 的内容，必须覆盖 stored XSS、终端转义符和超长 Unicode；
6. Artifact ref 默认只显示 kind/availability，不返回 locator 或正文；未来若增加 evidence 详情，需要独立 ADR、显式用户动作、强类型 reader 与单独审计测试；
7. HTTP 错误不得返回 SQLite path、workspace path、SQL、异常栈、配置或 credential。

## 7. 本地 Server 与鉴权

V1 只支持用户显式命令启动，例如 `kite logs serve`；实际命令名在 ADR Gate 固定。

- 默认绑定 `127.0.0.1` 和 `::1`，端口可为系统分配；
- 禁止监听 `0.0.0.0`、局域网地址或公网地址；
- 每次启动生成高熵临时 access token，不写入 Runtime Event；
- 浏览器 bootstrap 使用一次性本地授权交换，随后设置 `HttpOnly + SameSite=Strict` session cookie；token 不保留在 URL query、浏览器历史或日志；
- 固定 Host allowlist、Origin 检查、无宽松 CORS、严格 CSP、`X-Content-Type-Options: nosniff`；
- 所有 API 都要求本次 Server 实例的授权；静态资源不能绕过 API 鉴权读取本地文件；
- idle timeout、SIGINT/SIGTERM 与显式关闭共享幂等 shutdown；关闭只释放 reader/listener，不修改 Runtime Session；
- Server 状态和访问 token 不进入 Session Logger、Runtime Store 或 remote observability。

## 8. SQLite 读取与并发

新增 SQLite read-only adapter，而不是复用拥有写权限的 `createSqliteRuntimeStorage`：

- 使用 `SQLITE_OPEN_READONLY | SQLITE_OPEN_NOFOLLOW`；
- 复用 current-format metadata、schema、epoch 与 codec 校验，但绝不调用 schema initialization；
- 只暴露 `RuntimeLogQueryPort`，不暴露 transactions/effects/checkpoints/delete；
- macOS/Linux WAL 与 Windows DELETE journal 都必须验证 live writer + short reader 并发；
- 所有查询有 limit，reader 不持有跨请求长事务；busy/locked 返回 typed `temporarily_unavailable`；
- DB 文件、父目录、WAL/SHM 的 link/identity 安全要求沿用 Store current boundary；
- V1 优先复用现有 `(session_id, sequence)` 索引，不修改 Store schema；如果会话列表或过滤需要新持久索引，必须先通过 ADR 与 Store schema/epoch Gate，不能静默改变当前格式。

## 9. 实时增量

SQLite 仍是实时页面的最终事实源：

1. 页面初次加载先分页回填 SQLite；
2. SSE 只发送 `session_changed(sessionId,lastSequence)` 与连接健康状态，不把未提交事件当日志；
3. Server 收到 invalidation 后调用 `listRuntimeLogEvents(afterSequence)` 回填；
4. 同进程组合可使用现有 Runtime subscription 作为低延迟 invalidation，但不能以其 256 条内存 history 替代 SQLite；
5. 独立进程使用有界轮询观察 `runtime_sessions.updated_at` 与选中会话的 last sequence；
6. SSE 使用 session sequence 作为 `Last-Event-ID`，重连后再次从 SQLite 回填；
7. 浏览器落后、队列溢出或 Server 重启只丢 invalidation，不丢 durable 日志。

## 10. Web 页面 V1

V1 页面包含：

- 左侧会话列表：搜索、更新时间、模型、生命周期、最后 sequence；
- 主时间线：按 category/type/status 过滤，支持前后分页和“跟随最新”；
- 事件详情：结构化字段、causation link、Subagent/Tool/Model invocation 关联；
- 失败诊断：显示低敏感度 failure kind、ToolOutcome、Subagent diagnostic code/stage；
- 完整性与连接状态：current format、last sequence、SSE 状态、ephemeral 未持久化说明；
- 大内容折叠、复制安全文本、JSON-safe 结构视图；
- 空、损坏、busy、会话删除和 Server 关闭的独立状态。

V1 不提供会话操作按钮、SQL console、Artifact 文件浏览器、下载整个数据库或任意文件路径访问。

## 11. ADR Gate

实施前新增 ADR，至少决定：

- Server 是独立 `kite logs serve` 进程还是 Runtime 同进程可选 composition；
- HTTP DTO 与 `RuntimeLogQueryPort` 的 package owner；
- loopback token/cookie bootstrap；
- content/detail 与 private Artifact 的边界；
- V1 是否保持 Store schema 不变；
- Server entrypoint 与 package scripts 的无版本命名；
- 是否需要 feature flag，或以显式启动命令作为唯一 admission。

ADR 接受前只能编写方案和测试 fixture，不得创建生产 listener 或扩大导出面。

## 12. 实施 Tasks

### LOGWEB-00：ADR 与基线（已完成）

冻结数据源、owner、HTTP 安全、命令入口、Store schema 不变条件和性能基线。记录当前大 Session 的 event 数、SQLite 大小、列表/分页延迟和 live writer 模式。

基线（2026-08-23，本地 macOS arm64，current Store5/State26，WAL live writer）：10,000 个
durable event 的数据库为 1,622,016 bytes；写入耗时 644.5 ms；100 条会话列表查询 0.28 ms；
200 条反向事件页查询 0.67 ms。该记录只用于后续 Server/Web 回归比较，不改变 V1 的 schema/index。

### LOGWEB-01：Contract DTO（已完成）

在 Runtime Contract 新增 logs query/presentation DTO、cursor validator、错误码和完整性 DTO；禁止 SQLite/HTTP framework 类型进入 Contract。

### LOGWEB-02：Host 只读查询 Port（已完成）

在 Host storage 定义 `RuntimeLogQueryPort`，覆盖会话分页、事件分页、last sequence、session completeness；不并入现有可写 `SessionStore` 方法集合。

### LOGWEB-03：SQLite read-only 实现（已完成）

实现 current-format preflight、只读连接、参数化 cursor SQL、codec decode、busy/corruption 分类及 WAL/DELETE 并发测试。任何 schema/index 变化触发 ADR/epoch Gate 并停止本 Task。

### LOGWEB-04：Exhaustive 展示投影（已完成）

实现 RuntimeEvent → Web DTO 的 exhaustive projector、安全长度边界、terminal/failure/Subagent 关联与 secret/XSS fixtures；不复用 Session Logger mapper，因为二者目的和内容边界不同。

### LOGWEB-05：Server admission 与生命周期

实现显式 CLI 入口、loopback listener、token bootstrap、cookie、Host/Origin/CSP、idle/shutdown 和只读 composition。未授权、非 loopback 或 reader preflight 失败时零日志数据返回。

### LOGWEB-06：HTTP/SSE API

实现 sessions/events/detail/completeness/health 路由与 SSE invalidation；所有请求 schema 校验、limit、abort 和 typed error 统一收敛。

### LOGWEB-07：Web UI

实现会话列表、时间线、过滤、详情、跟随最新、完整性和错误状态；浏览器不保存 access token、SQLite path 或事件正文缓存到持久 storage。

### LOGWEB-08：并发、规模与恢复验证

覆盖 append 中分页、SSE 断线、Server 重启、TUI/CLI live writer、Windows DELETE、WAL、10 万事件 Session、损坏 current event、旧 epoch、会话删除和 reader busy。

### LOGWEB-09：文档与发布入口收敛

新增 `docs/active/local-session-log-server.md`，更新六概念架构、文档映射、CLI/help/package scripts；删除或修正失效的 root `src/web-server` 脚本，不保留双入口。创建完成记录并执行全量门禁。

## 13. Task 执行矩阵

| Task | dependsOn | 文件/产出 | 定向验证 | 迁移与回滚 |
| --- | --- | --- | --- | --- |
| `LOGWEB-00` | 用户裁决、当前 State26/Store5 | ADR、基线报告 | ADR/docs Gate、基线脚本 | 未接受 ADR 时保持 draft、零生产入口 |
| `LOGWEB-01` | `LOGWEB-00` | `runtime-contract` logs DTO/tests | Contract typecheck/test、unknown-field negatives | 删除新增 DTO 即回滚，Store 不变 |
| `LOGWEB-02` | `LOGWEB-01` | Host `RuntimeLogQueryPort`、fake conformance | Host storage/contract tests | Port 无 production adapter 时不可达 |
| `LOGWEB-03` | `LOGWEB-02` | SQLite read-only reader、cursor queries | Store conformance、WAL/DELETE、corrupt/busy tests | 关闭 reader；禁止写 Store 或兼容 fallback |
| `LOGWEB-04` | `LOGWEB-01` | App exhaustive projector、privacy fixtures | event corpus、secret/XSS/size tests | 未映射事件显示固定 unavailable，不透传 raw JSON |
| `LOGWEB-05` | `LOGWEB-03`,`LOGWEB-04` | CLI admission、listener、auth、lifecycle | loopback/auth/Host/Origin/CSP/shutdown tests | 移除显式入口，Runtime 不受影响 |
| `LOGWEB-06` | `LOGWEB-05` | HTTP/SSE API | API schema、pagination、Last-Event-ID、abort tests | API 不可用时 SQLite replay 仍正常 |
| `LOGWEB-07` | `LOGWEB-06` | Web UI | component/browser E2E、stored XSS、narrow viewport | 静态 UI 可独立移除，不改变 Server/Store |
| `LOGWEB-08` | `LOGWEB-03`,`LOGWEB-06`,`LOGWEB-07` | concurrency/scale/recovery qualification | 10 万事件、live writer、跨平台 CI | 任一平台不通过则不声明支持，不放宽安全边界 |
| `LOGWEB-09` | `LOGWEB-08` | active docs、map、help/scripts、完成记录 | docs-impact/docs、typecheck/build/default/E2E | 文档与入口未共同收敛则 blocked |

## 14. 风险与控制

| 风险 | 控制 |
| --- | --- |
| Server 直接返回 raw event 导致内容或 credential 泄漏 | exhaustive projector、无 generic JSON endpoint、secret fixture |
| 长会话一次性加载导致内存或 UI 卡死 | 强制 cursor/limit、反向首屏、虚拟列表、10 万事件测试 |
| live writer 被 reader 长事务阻塞 | read-only short query、无跨请求事务、busy typed response、WAL/DELETE 测试 |
| notification 断档造成页面漏事件 | subscription/SSE 只作 invalidation，始终按 sequence 回填 SQLite |
| 跨会话时间戳相同或 fork 时间回退 | V1 不承诺全局严格顺序；单会话只认 sequence |
| SQLite 格式变化破坏已有 current Session | V1 默认零 schema 变化；需要索引时先 ADR/epoch Gate |
| localhost 被 DNS rebinding 或恶意网页访问 | loopback bind、Host/Origin、token/cookie、无 CORS、CSP |
| Artifact 被“查看详情”旁路展开 | V1 无 Artifact 正文 API；后续单独 ADR 和强类型 reader |
| Server 被误认为 Runtime authority | query-only Port、无 command/transaction/effect capability、关闭 Server 不影响 Runtime |

## 15. 验证 Gate

实施完成前至少通过：

```bash
bun run typecheck
bun run check:core-boundary
bun run check:runtime-packages
bun run check:pre-release-architecture
bun run check:docs-impact
bun run check:docs
bun test packages/runtime-contract/test
bun test packages/runtime-host/test
bun test packages/runtime-storage-sqlite/test
bun test tests/runtime/store.test.ts
bun test tests/server/logs
bun test tests/e2e/local/log-server
```

还必须有浏览器级验证证明：未授权访问为零数据、恶意 stored content 不执行、分页无重复/丢失、SSE 重连从 SQLite 补齐、Server 关闭后 TUI/CLI 和 Runtime replay 不受影响。

## 16. 停止条件

出现以下任一情况立即停止实施并报告：

- 为完成页面需要让 Server 获得写 SessionStore、Runtime command 或 Artifact raw path；
- current codec 无法在只读连接上验证事件，提议绕过 decoder 直接返回 JSON；
- 需要修改 Store schema/epoch，但尚无接受 ADR 和 clean-cutover 决策；
- Windows DELETE 或 WAL live reader 会无界阻塞 Runtime writer；
- 无法在浏览器边界证明 credential、Provider body、reasoning 与私有 Artifact 不泄漏；
- 文档、实现与测试对“完整日志”的定义不一致。
