# ADR-0152：Kite Home 收敛为单 Service、单 SQLite 与最小临时 Runtime

状态：accepted

日期：2026-08-30

决策者：用户直接指令

相关：ADR-0144、ADR-0147、ADR-0148、ADR-0150、ADR-0151，
[`Kite Home 边界与本机 Runtime 简化方案`](../space/plans/2026-08-30-kite-home-and-local-runtime-simplification.md)。

## 背景

当前一个canonical Kite home同时包含Service、Coordinator、Workspace Worker、Web Gateway四套process state，Catalog加
per-Workspace Store数据库、generation pointer/journal/fence/manifest、七类filesystem Artifact namespace；跨home resource lease
又写到`~/.kite-code-coordination`。Web首次缺asset还证明这些状态会形成用户必须理解和人工恢复的启动阻断。

把这些内容分别迁到OS runtime/state/data目录可以清空Kite Home，却不会减少process manager、数据库协调、Artifact reader/GC或
migration state machine，反而增加新的root discovery、备份和清理规则。用户要求的是架构简化，而不是重新分类现有复杂度。

## 决策

### 1. 持久内容只有Kite Home与一个SQLite

每个canonical Kite home最终只包含：

```text
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

`skills/`是用户声明式扩展配置，`sessions/`保持现有Session Logger policy。除SQLite自己的exact companion外，不允许socket、
descriptor、token、lock、intent、pointer、journal、fence、manifest、Artifact、export、editor temp或migration JSON sidecar。

所有durable Runtime、Workspace目录索引、Controller/effect/recovery、Run/receipt与private Artifact事实由
`~/.kite-code/kite.sqlite`的一个writer connection拥有。不得保留Catalog DB、per-Workspace DB、sidecar DB、SQLite `ATTACH`、
跨库outbox、dual write或fallback reader。

### 2. 专用表保留领域边界

单数据库不等于通用blob表。现有Runtime表继续保留event、snapshot、named snapshot、preimage、effect lease、receipt和Run语义；
新增`workspaces`及Session的`workspace_id`外键，Directory直接从同一事务事实投影。删除Session时保留带`workspace_id`的tombstone与
receipt，不再需要Catalog mirror或`session_directory_outbox`。

Filesystem Artifact迁入专用表：

- `model_artifacts`：surface、response与provider-options canonical JSON；
- `plan_artifacts`：PlanDocument canonical JSON、Markdown、task/plan/version与structural digest；
- `capability_artifacts`：invocation-bound result canonical JSON；
- `sandbox_preparation_artifacts`：prepared execution canonical JSON与expiry；
- `subagent_task_artifacts`、`subagent_lifecycle_artifacts`、`subagent_continuation_artifacts`：各自现有owner、schema与canonical正文；
- filesystem preimage继续使用`runtime_file_preimages`，不复制第二份。

每张表保留对应format version、content digest、byte length与identity key；reader仍执行当前strict schema/canonical/digest/size校验。
Runtime State中的path-free ref保持逻辑形状，不暴露rowid或数据库路径。正文不进入普通event/snapshot、Browser projection、Session Logger
或generic query。各领域GC只删除其owner证明unreachable的行，不建设global Artifact registry。

### 3. 一个Service进程拥有全部本机Runtime

每个canonical Kite home最多一个Local Service。Coordinator Directory/admission、Workspace execution context、Runtime
Host/Controller/effect、Agent API与Web Gateway变成Service内模块，不再对应companion process、独立Store或持久process state。
Workspace仍是Trust、配置、Skill、MCP、Sandbox与查询的强隔离scope，但不再拥有daemon、DB或idle lifecycle owner。

TUI/CLI/native client只ensure Service。Service拥有一个loopback HTTP listener，继续保持Agent API和Browser route/auth codec隔离；
`kite web`只做asset preflight、向Service注册canonical static root/digest并取得内存中的一次性launch URL。Browser和Vite都不启动
本机Service。`web stop`撤销Browser session/ticket并关闭对应WebSocket，不停止Service或Agent API listener。

现有durable restart recovery保持：Service重启后从SQLite恢复pending Turn、interaction、receipt、Controller/effect与subagent事实；
只有当前authority确实无法确认的外部effect进入`unknown`，不得把所有in-flight工作统一取消或自动重放。

### 4. OS runtime只负责发现活Service

OS runtime不保存持久业务数据。POSIX使用owner-only、按canonical home digest隔离的Unix socket与一个lifecycle reservation；Windows
使用SID-bound、按home digest隔离的first named-pipe instance。same-UID/SID恶意进程继续属于当前threat model外，但strict handshake仍
校验instance、protocol、client contract与build；endpoint squatting、stale或identity不确定返回typed unavailable，不删除或spawn第二owner。

不同custom home是独立profile，不建立通用的跨home资源互斥。若未来出现可复现的跨profile资源冲突，应为具体资源另立决策；当前
不得预先增加共享lease，也不得建立durable OS state/data root。

### 5. 一次性离线clean cutover

迁移只在全部旧Service/Coordinator/Worker/Gateway confirmed stopped且现有Store maintenance predicate收敛后执行：

1. 对`checkpoints.sqlite`、全部Store epoch、active Catalog/Workspace Store及WAL/SHM取得一致只读snapshot；
2. 在Kite Home创建`kite.next.sqlite`，其内部migration metadata绑定source logical digest、schema、nonce与phase；
3. 按Workspace、Session、Runtime fact、authority metadata、Run/receipt、tombstone和每类Artifact逐项copy并deep validate；
4. duplicate Session/receipt/workspace identity、missing Artifact、pending unsafe cleanup、corrupt/unknown source全部blocked，禁止覆盖或丢弃；
5. target fsync和parent directory durability完成后原子rename为`kite.sqlite`；crash-after-rename由target内部metadata识别并继续验证；
6. 新Service从单DB成功reopen和恢复后，才删除旧DB/layout/Artifact/process state与`~/.kite-code-coordination`。

迁移不在线运行、不dual write、不自动import compatibility source。`kite.next.sqlite`identity不确定时不得删除。source清理前可整体回滚；
新Store产生写入并清理source后只允许向前修复。

### 6. Web启动失败不产生状态

`kite web`在任何token、listener或launch session创建前验证static root、`index.html`、OpenAPI和Vite JS asset；缺失返回
`web_assets_missing`。Service/Web readiness失败只清理本次内存对象和confirmed-dead exact child；由于目标没有Gateway process state，
新架构不需要永久`web recover`。transition期间保留现有recover处理legacy exact state，清场完成后删除。

## 局部替代关系

- 替代ADR-0147关于独立Coordinator、per-Workspace Worker/Store与独立Web Gateway process的拓扑；Observer-only Web产品权限继续有效。
- 替代ADR-0148关于Catalog+Workspace Store、generation pointer/journal/fence/manifest的物理布局；其unknown/corrupt blocked、
  source preservation与no dual-write原则继续有效。
- 替代ADR-0144关于Kite Home内descriptor/token/lock和随机HTTP descriptor discovery的局部实现；单本地用户、Trust、neutral process、
  exact lifecycle与recovery原则继续有效。
- ADR-0151的asset-first、typed diagnostic和exact recovery原则继续有效；独立Gateway launch intent只作为transition legacy处理。

## 备选方案

- 将现有状态搬到OS runtime/state/data三个root：拒绝。只改变位置，不减少长期owner和恢复协议。
- 保留多数据库但把manifest放到别处：拒绝。跨库一致性、pointer和backup复杂度仍存在。
- 通用`runtime_artifacts(kind, BLOB)`：拒绝。它会模糊schema、隐私、GC、reader和恢复authority。
- 把Artifact正文写入event/snapshot：拒绝。会改变projection/retention并泄漏private内容。
- 在线双写迁移：拒绝。无法原子覆盖多Store与外部Artifact，也会保留第二authority。

## 后果

- Kite Home、备份、恢复和问题诊断只有一个持久数据库；不再要求用户理解daemon state、generation或Artifact目录。
- 实现必须新增单Store schema、DB-backed typed Artifact adapter与完整离线迁移，改动大于简单path relocation。
- 单Service故障影响全部Workspace，但现有Session级mailbox、SQLite transaction和durable recovery继续隔离逻辑工作；没有量化瓶颈前
  不重新分进程或分库。
- Browser仍需要loopback HTTP，但只有Service一个process owner；OS runtime只保存native discovery endpoint，不保存HTTP credential文件。

## 回滚

cutover前可以整体回滚代码和丢弃exact`kite.next.sqlite`；所有source保持不变。切换后在新Service第一次写入前，可以依据target内部
migration metadata恢复source；第一次新写入后不得自动回旧DB。任何需要重新引入第二Service、第二DB、durable OS state/data root、
filesystem Artifact或dual writer的修复都必须新增ADR。
