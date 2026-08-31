# ADR-0159：兼容客户端跨构建复用同一 Local Service

状态：accepted

日期：2026-08-31

决策者：用户直接指令

相关：ADR-0152、ADR-0155、ADR-0158。

## 背景

每个canonical Kite Home已经只有一个Local Service、一个Runtime Host、一个Store writer和一个`kite.sqlite`。但Native
`describe`仍把客户端的`expectedBuildId`当作普通连接门禁：只要TUI与正在运行的Service来自不同checkout或dirty build，manager就返回
`incompatible/build_mismatch`。这会让TUI、Web和未来桌面端虽然协议兼容、数据authority相同，却无法复用唯一Service；用户只能先找到原构建
停止Service，或者为同一份数据启动另一个profile，违背single-Service的产品心智模型。

`buildId`能够说明哪个bundle启动了进程，但不能单独证明客户端协议不兼容。真正的数据面兼容边界已经由Native request codec、Runtime
`protocolVersion`和`clientContractRevision`承担。把build同时作为连接兼容门禁，会把发布来源和wire contract混成同一个概念。

## 决策

### 1. 已就绪Service优先于客户端build

同一个canonical Kite Home存在可验证的ready Service时，TUI、CLI `run/resume`、`kite web`和未来本机客户端必须复用它，不因客户端
`expectedBuildId`与Service `buildId`不同而spawn、replace或要求第二数据库。Native `describe`是只读发现操作：只要request通过当前exact
Native codec，Service就返回自身真实descriptor、`buildId`、HTTP origin和restart-scoped access capability。

manager的`ensure`与`status`因此把兼容的跨构建Service视为`ready`。`kite web`和TUI `/web`使用该Service自己的origin与已挂载Web assets，
不会用调用方checkout的assets覆盖运行中Service。

### 2. 协议与client contract仍是硬门禁

客户端不得从build差异推断兼容，也不得忽略wire验证。Native frame/request/response必须通过exact schema；Runtime连接继续验证Service
descriptor、instance、`protocolVersion`与`clientContractRevision`。任何schema、Protocol、client contract、instance、PID/start identity或
endpoint证据不兼容/不确定都fail closed，保留现有owner且`spawn=0`。

`buildId`继续作为descriptor和Service identity中的真实provenance字段。Service回报的build必须在同一次发现和后续instance proof中保持一致；
客户端不能把自己的expected build回显成Service build，也不能从descriptor合成健康结果。

### 3. Lifecycle mutation保持exact-build控制边界

跨构建客户端可以发现、连接和读取Service，但不能通过Native `service_stop`停止它。`service stop`与`service restart`必须由与运行中Service
相同`buildId`的control client执行；不匹配返回`incompatible/build_mismatch`，Service保持ready。这样普通客户端可以共享唯一数据面，
同时旧checkout不能静默终止或替换另一个checkout启动的进程。

需要升级Service时必须显式从owner build停止，或使用不同`--kite-home`进行隔离验证。本决策不新增自动升级、handoff、兼容层、第二Service、
SQLite多writer或持久化版本协商状态。

## 局部替代关系

- 局部替代ADR-0152中strict handshake把client expected build作为普通连接门禁的结论；single-Service、single-SQLite和identity fail-closed继续有效。
- 局部替代ADR-0155中build mismatch阻断TUI/Web共享ready owner的结论；多个薄客户端连接同一Server及TUI Native transport结论继续有效。
- ADR-0158的Service根页面与无launch token结论不变；跨构建Web客户端仍只访问运行中Service的规范根地址。

## 备选方案

### 每次build变化都自动重启Service

拒绝。它会中断其他TUI/Web客户端和active Run，并把普通连接变成隐式lifecycle mutation。

### 多Service共享同一个SQLite

拒绝。SQLite写锁不能统一Runtime Host、Controller、Session mailbox、interaction、child process和恢复authority。

### 完全删除build校验

拒绝。build仍用于真实provenance、同一次Service identity一致性和stop/restart控制归属；只是不再代替协议兼容判断。

## 后果

- 用户启动一次Service后，可从另一个兼容checkout启动TUI或打开Web，继续看到同一Workspace、Session和运行状态；
- Service提供的Web UI与API始终来自同一个运行bundle，不会混用客户端checkout的静态资源；
- build变化不再制造普通连接阻断，但显式升级仍需要owner build或独立home；
- 测试必须同时覆盖跨build `describe/ensure/status`成功、跨build `service_stop/restart`拒绝，以及同home不spawn第二Service。

## 回滚

可恢复Native `describe`的exact-build拒绝并回滚对应manager诊断与文档，但会重新引入跨checkout TUI/Web不能共享唯一Service的问题。任何自动
Service升级、多Server共享Store或持久化协商机制都需要新的ADR。
