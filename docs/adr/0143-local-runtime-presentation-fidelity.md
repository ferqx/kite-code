# ADR-0143：本地 Runtime 展示保留完整可重放内容

状态：accepted

日期：2026-08-26

决策者：用户直接指令

相关：ADR-0030、ADR-0045、ADR-0049、ADR-0053、ADR-0056、ADR-0129、
ADR-0142、[`Kite Runtime Server V1 实施方案`](../space/plans/2026-08-26-kite-runtime-server-v1.md)。

## 背景

ADR-0142 建立了封闭 Protocol、transport-neutral Server/Client、唯一 Runtime Host 与独立 History Client
边界。最初实现把该边界同时当作高强度正文最小化边界：reasoning 只剩状态，动态工具名折叠为通用类别，
工具参数与结果被清空，TUI 再从摘要猜测展示。这样虽然没有传递 raw `RuntimeEvent`，却破坏了本地产品的
必要事实：Read/Find/Bash 无法显示目标与结果，Thought 无法在 reasoning 与工具之间切换，多个探索工具被
拆成碎片卡片，live 与旧会话 replay 也无法得到同一 UI 状态。

Kite Runtime Server V1 的生产消费者仍是用户本机的 TUI 与前台 CLI；stdio 由本机 parent process 拥有，
WebSocket 仅是 loopback development evidence。用户明确裁决：数据保存在用户本地，不应以泛化隐私理由
丢弃本地交互所需的普通正文；只需继续排除明显 credential 与内部 authority material。

## 决策

### 1. 本地展示 DTO 保真，顶层协议仍然封闭

`RuntimeClientEvent` 继续使用 exact discriminated union、严格 codec、字段 allowlist、JSON-safe 校验与大小
上限；未知字段和未知事件仍在 Runtime Host/Store/effect 前 fail closed。它不开放 generic object，也不允许
raw `RuntimeEvent`、State、Workspace authority、grant subject、provider credential/body、transport handle 或
Store locator 越过边界。

在该封闭 union 内，本地展示所需内容必须保留：

- reasoning segment 的稳定 `segmentId`、累计/完成状态与正文；
- canonical tool category 之外的有界本地 `displayLabel`；
- 工具调用的 JSON-safe arguments，包括普通 path、pattern、URI 与 command；
- 工具终态的 status、exit code、stdout、stderr、line/token count 与封闭 termination reason；
- user cancellation 的 closed cause，以及 Thought/caption 组装所需的 model duration/tool-call count。

边界只递归过滤明显 credential-shaped key/value 和禁止控制字符，并实施传输安全所需的深度、项数与文本
上限。不得再以“可能敏感”为由把普通本地路径、查询、命令或结果统一替换为空对象/通用摘要。需要承载超出
单事件上限的内容时使用分页、分块或 Artifact 引用，不通过放开任意对象绕过限制。

### 2. 完整历史与实时事件使用同一消费事件和 reducer

完整 durable history 的路径固定为：

```text
TUI → RuntimeClient.history → App history adapter
    → RuntimeLogQueryPort → SQLite readonly log
    → exhaustive source projector → RuntimeClientEvent[] → TUI reducer
```

History adapter 必须向前分页直到读取该 Session 的完整有序日志；Host 的短 notification history 不得冒充
完整历史。TUI 的 list/load persisted session 不得穿透 SessionManager 直接读取 Store。

`model.reasoning_delta`、`model.reasoning_completed`、`model.text_delta` 与 `tool.progress` 是 live ephemeral
事件，不要求逐 delta 持久化。durable `model.responded` 已保存完整 reasoning/text/tool-call facts；历史 mapper
从这些 closed durable facts 生成等价的 completed reasoning/text/client terminal 序列。历史交互只用于展示和
恢复检测，绝不恢复 settlement callback 或旧 interaction authority。

实时与 replay 都只进入 `handleClientEventAction`。TUI 以 call ID 缓存 queued payload，在 started 时物化，
在 terminal 时使用同一 result formatter；reasoning、caption、工具聚合、Subagent 与 user cancellation 也由
同一 reducer 状态机处理。模型正文、reasoning 与 responded 必须保留同一 `requestId`；TUI 以该 identity
更新唯一回答槽位，不从 block 邻接关系反推归属。Server/App projector 不预先决定最终卡片布局，TUI 不再
从缺失字段反推事实。

### 3. History 仍与 Runtime Server execution authority 正交

“RuntimeClient 返回完整会话历史”不表示 Server core 成为第二日志 owner。Server 仍只接收
`RuntimeAccess + admission`，不打开 SQLite、不 fold Runtime State、不拥有 history retention。App 在 composition
root 将只读 `RuntimeHistoryClient` 注入同一个 RuntimeClient facade；control transport 与 durable history source
保持两个正交 port。

### 4. 本地产品展示不是 observability 或生产 Web 准入

ADR-0056 的 metadata-only metric、health、report、telemetry 和诊断日志约束保持不变。本 ADR 允许的正文只
进入用户本地产品展示与其 durable Session history，不得复制进 observability、stderr、metric、remote reporter
或 release evidence。

ADR-0053 也保持不变。loopback development WebSocket 能传递同一 closed DTO，只形成 development evidence，
不创建 production-supported Web 入口、远程多用户信任模型或 hosted data policy。

## 对 ADR-0142 的修订

本 ADR 仅取代 ADR-0142 §3 中“reasoning、internal path/locator 一律不得越过 wire”以及由此推导的本地正文
清空策略。ADR-0142 的 closed protocol、唯一 Runtime owner、Workspace admission、receipt 原子性、transport
边界、History authority 和 ADR-0053 产品范围全部继续有效。

## 后果

- TUI 可以依据服务 facade 返回的完整 client event history 自行组装，并与 live 状态保持同构。
- Protocol/event schema 变大，但仍是严格、可生成、可做 hostile-input conformance 的 repo-private V1。
- 普通本地内容不再因泛化隐私策略丢失；明显 credential 和内部 authority material 仍 fail closed。
- History mapper 必须对长于 Host replay window 的 Session、ephemeral→durable replay 投影和损坏日志负责。
