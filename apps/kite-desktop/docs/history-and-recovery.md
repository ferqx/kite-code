# 历史目录与连接恢复

产品行为见[桌面手册](../../../docs/handbook/clients/desktop/README.md)。[DesktopClient](../src/client.ts)负责查询与恢复，[App](../src/App.tsx)负责选中空间和执行项目之间的交接。

## 不依赖项目环境的历史

启动首先接入原生宿主持有的 App Server；没有服务时可以不指定执行工作区启动。目录、持久会话投影、订阅初始快照与历史均从同一 profile Store 读取，不解析旧项目的文件系统，不要求 Git、模型配置或 Workspace Trust 可用。模型、项目和分支读取在目录之外完成，各自报错；失效路径仍可阅读历史，发送前才验证已登记目录的规范路径和信任。

目录使用 `history/list_sessions` 的轻量摘要与持久 Workspace membership，不请求所有会话完整投影，也不依靠逐项目 Trust identity 查询归组。已登记规范路径的文本摘要仅用于将 Store workspaceDigest 映射到本地选择记录，不授予权限；未登记的持久空间仍显示历史。每个空间独立读取 100 条，额外读取 profile 目录以发现未登记空间；最多八个并发读取，单个响应即可更新对应列表，下一页沿各自 cursor 继续。一个空间失败保留已有行并显示局部错误。目录缓存刷新保持已有条目顺序，共享侧栏按 `updatedAt` 倒序排序后再分批展示；所选实时投影覆盖旧摘要；投影省略可选 `updatedAt` 时保留目录时间，避免只读打开会话清空时间并改变排序；无后台全会话订阅。

只读目录请求有 10 秒边界，可重试一次；明确不可重试错误不会重试。选择会话先加载并展示完整持久历史，再查询实时投影与等待订阅 ready；首次阅读不依赖实时链路健康。上述历史加载／投影、查询与订阅共用 20 秒边界；完整校准前禁止发送和交互操作，连接快照不能提前恢复 ready。订阅初始水位比已读历史新时，在已建立订阅缓冲后续事件的同时再校准历史，避免两阶段之间漏消息；水位未推进不重复读取。实时查询或订阅失败保留已读正文，发送、停止与审批仍不可用，失败后可沿既有入口重试。选中代次隔离迟到结果；读取失败保留已读正文，明确不存在、空间身份不匹配或 unauthorized 则清除正文。

## 启动页

[App](../src/App.tsx)在首次挂载期间只显示启动页，等待项目列表读取、原生连接、首屏目录与当前项目准备检查结束；保存的选中会话也先完成恢复尝试。`restoreWorkspace` 等待已有 workspace preparation，分支检查与 Trust／模型读取均先取得结果或局部错误。无模型、失效目录与单个目录失败保留既有局部处理，不成为历史阅读门禁。连接失败或目录完全不可读时提供显式重试；重试复用健康 Service，并在此前目录尚未成功时重新读取，不启动第二个服务。

启动状态仅由本次页面挂载持有，不新增持久状态、延时或后台进程。准备完成后直接挂载共享主页面；窗口 focus／visibility 恢复监听只在主页面已进入后运行，后续断线不会切回启动页。样式在 [startup.css](../src/startup.css)，启动隐藏、失败重试、空目录和断线保留草稿由 [UI 测试](../test/ui.test.tsx)覆盖。启动页不代表 300ms 性能目标已经完成。

## 阅读与执行项目

点击任意空间的已有会话只切换读取与订阅，不关闭原 Service，不停止正在执行的任务。同一执行项目下继续会话直接提交给 Service，不重复执行项目选择与目录预检；Service 保留实际执行条件与授权核对。草稿按选中空间与会话隔离。显式选择新对话项目或向其他空间实际发送时先验证目录，再检查当前 Service 是否有活动任务；有活动任务才确认停止，之后等待旧服务清理、激活并授权明确选择的项目、重新读取会话后发送。当前 Service 仍只持有一个执行工作区；历史 membership 不授予跨工作区写权限。普通资料目录可执行，无须 Git；分支功能仅适用于 Git 仓库。

## 自动重接与未知结果

完整页面刷新复用原生 protocol peer，详见[原生连接恢复](new-conversation.md#页面刷新与连接恢复)。传输关闭或断开时立即撤销 ready，由唯一内部恢复循环重新接入，间隔依次为 250、1000 毫秒，此后上限为 3000 毫秒，直到恢复或当前生命周期结束。恢复选中会话的快照、订阅和历史，不以窗口聚焦或用户点击为触发条件。项目／分支切换和退出取消待执行的恢复，并等待正在接入的尝试结束后关闭当前服务，避免迟到恢复与下一项目争用进程。

主界面不展示本地服务的连接状态、重连／断开操作或未就绪提示。恢复期间保留已读消息、空间列表与草稿，禁止使用旧 ready 发送；内部连接错误不写入正文提示，也不冒充项目、目录或模型错误。未知命令结果仍明确提示用户检查实际效果，不以恢复成功掩盖未知结果。首次启动失败仍在独立启动页处理，恢复机制不绕过制品验证，也不自动替换损坏的安装文件。

客户端 transport close 只调用 `runtimeDetach`，取消旧页面的接收与订阅，不关闭 Service stdin。只有明确执行项目／分支切换与退出才调用 `runtimeClose` 关闭自有 Service。宿主已有健康 Service 时复用；确已退出才允许重新启动，不能承诺恢复已停止的执行。命令回执丢失仍保留“结果未知”提示，自动恢复不会重放创建、发送、审批、配置或 Git 命令。

[renderer 连接 owner](../electron/runtime/renderer-connection.ts)在接收取消与 Service 帧同时完成时，先处理已经取得的帧再切换代次。已消费的 initialize 回执必须更新原 peer 的初始化事实，迟到的 subscribe 回执继续释放旧订阅；不能把“取消先唤醒”当作“没有收到帧”，否则会把初始化永久留在等待状态，使重复重接也无法恢复。[连接回归](../test/host-renderer-connection.test.ts)以确定的取消／回执交错验证这一边界，仍复用同一 Service，不重发初始化或业务命令。

## 验证

[导航集成测试](../test/navigation.test.ts)使用真实 Service 验证失效目录和模型配置下读取历史、跨空间只读与执行限制、局部失败和旧响应隔离；[恢复测试](../test/resilience.test.ts)验证写入后丢失回执的自动恢复与不重放；[配套 Service 测试](../test/host-paired-service.ts)驱动 Electron host 与真实 stdio Service，[renderer 连接测试](../test/host-renderer-connection.test.ts)覆盖 detach、reattach、initialize 复用和旧代次隔离。SQLite [目录测试](../../../packages/runtime-storage-sqlite/test/kite-home-directory.test.ts)覆盖超过千条记录的有界分页、稳定 membership 与空间过滤。这些测试不替代 Electron 窗口、preload 与系统输入法的原生验收。

本地目录的存在状态由 `listProjects` 读取时查询，不写入项目偏好。目录缺失只让空间名称使用次级文字色，不显示“尚未关联本地目录”常驻提示，也不据此禁用会话。返回已连接窗口只更新本地目录状态，不重新查询会话目录；历史目录在连接、新建与所订阅运行结束时更新，未订阅的外部变化可能延迟到下次目录读取。

## 启动预算与验证边界

连接与首屏目录的目标预算为 300ms。启动链路只打开和核对 Store 文件、格式与结构，读取有界目录；完整会话恢复检查按目标 Session 在同一 SQLite read snapshot 内完成，Artifact 内容由所属 reader 在访问时校验。显式 release preflight 仍执行完整 SQLite physical/FK 检查，不把此全库维护工作重复放进各个 reader 构造函数。跨包约束见[SQLite Runtime Log](../../../docs/active/sqlite-runtime-log-query.md)。

Electron 宿主在每次新建配套进程前读取并校验完整 Service SHA-256；摘要与 expected server version 来自构建时编入 main bundle 的已验证清单，不从运行时资源清单换版本，也不改成未经校验的文件缓存。Builtin 的 tokenizer 在第一次计数时加载，历史浏览不初始化词表。

2026-09-11 Tauri 开发构建曾使用本地数据库的隔离副本测量：268,935,168 字节、2 个空间、85 个会话、24,889 条事件。优化后空闲环境下 5 次“完整程序校验 → 新建 Service → initialize → 100 条首屏目录返回”为 231、187、190、194、190ms；同一 Service 的 renderer 重接与目录读取为 3、3、3、3、6ms。新进程测量复用了 OS 文件页缓存，不等于清空系统缓存后的磁盘冷启动；当时刚构建的 Service 在无并发浏览器操作时首次运行仍观测到 611ms，并发启动浏览器的一次观测达到 650ms。这些数字只说明 Service 与历史负载的既有基线，不能当作 Electron 冷启动或端到端资格。

另用实际 App／共享组件与 85 条隔离展示数据，在内置浏览器两次 requestAnimationFrame 后核对 85 行已提交，观测为 47ms。此项与原生服务计时分开，不能相加并宣称已经取得 Electron 从系统启动到窗口绘制完成的端到端资格。当前 [host lifecycle 测试](../test/host-lifecycle.test.ts)、[配套 Service fixture](../test/host-paired-service.ts)与待完成的 packaged Electron smoke 分别核对宿主、真实执行和窗口链路；成功证据取得前，300ms 端到端目标仍未满足。

## 会话正文缓存与校准

当前选择的校准结果同时绑定 AbortController 与 Runtime subscription generation。已校准会话出现 durable gap、失去 ready 或订阅 generation 更换时，立即失效操作资格，保留正文并复用原有 20 秒 `selectSession` 校准。History 读取期间如果 generation 再次变化，在同一加载期限内重新建立历史上界；同一代次之后的实时事件由订阅缓冲并按原有消息身份折叠。普通同代次快照更新不触发完整重读；失败不恢复 ready，也不清除仍有读取权限的正文。共享 Client 的 resync 标记不充当第二份历史水位或自动命令重放开关。[校准回归](../test/session-calibration.test.ts)在真实 Service 的 renderer 边界丢弃一条用户消息，验证自动补读、期间禁止操作、恢复后不重复，以及普通目录刷新不重读正文。

[DesktopClient](../src/client.ts)拥有当前阅读快照与[非当前历史缓存](../src/session-cache.ts)。缓存条目按连接内 sessionId 读取，保存已核对的 workspaceDigest、消息引用、已加载标记及估算体积。take 将条目移交当前视图，离开时保存最新快照；流式更新不复制缓存或反复估算体积。缓存不保存操作权限、原始事件、React 元素或 DOM。草稿和阅读状态继续由原 UI owner 管理，正文淘汰不删除它们。

非当前会话采用 LRU：最多 12 条、总计 64 MiB、单条 16 MiB。字符串按 UTF-16 加对象／集合开销估算；超单条预算直接不保留，估算超过上限即停止扫描。预算不包含当前正文、在途 transcript 和校准中的新消息，不等于应用堆上限。缓存只在当前连接有效；detach／重建清空非当前条目，当前正文可以留作断线阅读，但不得作为新连接的已校准状态或填回旧缓存。

`hasLoadedHistory`区分未加载与已加载的空会话；只有 `loadingSession && !hasLoadedHistory` 显示整页加载。命中先发布正文，再重新查询、订阅和完整加载历史。重试复用同一入口，同一连接与会话的在途 Promise 单飞；旧选择不能修改当前正文、缓存或错误。失败不因 finally 结束 loading 而重新开放操作。`newSession` 仍只返回新会话 ID；首次发送的显式目标与当前阅读选择分离，已创建目标通过最新会话查询与工作区核对发送，不因用户切到另一个正在校准的会话而串改目标。当前阅读会话的发送、停止与交互仍须通过校准门禁。成功校准不改变 Conversation key，不打断向上阅读。

客户端将选择的 AbortSignal 传入 `RuntimeHistoryClient.loadSession` 的第三个可选参数；协议适配在请求前与每页响应后检查取消，只丢弃在途响应并停止后续页，不新增服务端取消请求或重放命令。[历史投影](../src/history-projection.ts)每批最多 200 个事件、约 8ms 让出主线程，完成后一次发布；通过展示字段比较复用相同消息对象，无变化时复用原数组。持久通知 revision 是同会话源记录序号，只补入完整历史水位之后的消息；临时流序号不推进历史水位，最终持久输出覆盖旧临时内容。完整 transcript 与旧快照不进入长期订阅闭包。

连接快照只在字段实际改变时通知页面，未变化的会话摘要沿用数组引用。App 的常驻回调不捕获含正文的完整 view；共享 SessionPage 将 messages/fileChanges 从常驻回调捕获的 props 中分离，避免首次页面的正文绕过 LRU 长期保留。这些调整不改页面布局、文本选择或 Web 的 REST 更新机制。

[缓存回归](../test/session-cache.test.ts)核对空会话、引用移交、100 会话遍历、数量／体积淘汰和清空；[校准集成回归](../test/session-calibration.test.ts)使用真实 Service 核对单飞、实时衔接、失败重试、拒绝读取、迟到失败及重连；[投影回归](../test/history-projection.test.ts)核对批次取消与引用复用。UI 首次／缓存加载条件见[UI 测试](../test/ui.test.tsx)，分页取消由 [runtime-client 测试](../../../packages/runtime-client/test/runtime-client.test.ts)覆盖。

## 缓存性能验证

以下 Tauri/WKWebView 结果为换型前缓存实现的历史证据，不代表当前 Electron 制品；当前 Electron 合并验证见[原生验收](native-validation.md#会话缓存合并复验)。

2026-09-12 在同一 macOS 26.6.2 / arm64 设备、Bun 1.4.0、React 19.2.7、Vite 7.3.6 production renderer 上对照基线 `928d98737722`。Tauri 使用 debug 宿主中的 WKWebView（1440×816）；通过仅用于验证的本机 HTTP invoke 桥接真实 stdio App Server，并在历史响应边界注入固定展示数据，不调用外部模型。此项验证原生渲染与客户端校准，不等于签名发布包、磁盘冷启动或完整原生 IPC 的端到端资格。

固定数据为两条会话，各 500 条交替用户／助手消息，约 100,000 个正文字符，工具详情默认折叠。每轮重置隔离 Store，避免 100 会话压力遍历遗留的目录行改变负载。以调用 selectSession 为起点，两次 requestAnimationFrame 后核对已挂载的 `.message` 数量；完成耗时另等待选择 Promise 和随后两帧。30 个样本按 nearest-rank 取 p50/p95。首次读取对照先创建 30 个会话，再按原顺序遍历，确保候选缓存未命中；两端使用相同目录规模。

| 原生窗口场景 | 基线 p50 / p95 | 本次 p50 / p95 |
| --- | --- | --- |
| 500 条缓存切换的帧探针 | 97 / 99ms | 83 / 87ms，均显示 500 条正文 |
| 500 条切换完整校准 | 116 / 117ms | 117 / 134ms |
| 首次读取完成（30 次） | 117 / 117ms | 117 / 117ms |
| 校准人为延迟 2 秒（单次） | 31ms 时仍为空，2139ms 完成 | 76ms 显示 500 条，2123ms 完成 |

无缓存基线的帧探针可能落在请求完成之前或之后，不能把空白首帧算成正文出现；延迟场景明确显示两者区别。缓存没有消除后台完整传输和投影成本，完整校准也不承诺加速。

Chromium 152 对实际 App 做弱引用与 GC 检查：依次离开 100 个 500 消息会话，只剩索引 88–99 的 12 份正文可达；断开连接后这些引用全部释放。renderer JS heap 在遍历前／遍历后 GC／断开后 GC 分别约 9.0 / 15.0 / 12.7 MiB，后者仍包含当前正文、目录和已有 UI 状态，不能要求回到启动值。最初的堆快照发现 App / SessionPage 常驻闭包保留第一份正文，修正后上述复验通过；预算及大条目淘汰由缓存回归独立核对。

同一 Chromium 窗口额外测量 5,000 条消息，其中 500 条工具各含约 4 KiB 输出，正文总计 2,947,890 个字符：创建并首次展示约 969ms，缓存重新挂载首帧约 337ms，完整校准约 875ms；无变化校准复用原数组。挂载阶段观测到 326ms 长任务，因此此规模仍会卡顿，不把 500 条的 100ms 目标推广到超长会话，也未附带引入虚拟列表。5ms 定时采样的 renderer JS heap 峰值约 104.4 MiB，结束并 GC 后约 23.3 MiB；另有约 42.9 MiB embedder heap。采样峰值不是严格瞬时峰值、整个应用 RSS 或 Service 内存，当前正文、在途历史、新投影及 DOM 不受非当前正文预算约束。

隔离渲染后，以同一 projectHistory 处理 5,000 事件（含 500×4 KiB 工具输出），初投影／相同内容校准约 302 / 331ms，事件循环探针最大间隔 11.6ms，Long Tasks 观测中无超过 50ms 的任务。单个 2 MiB 工具输出另测投影 0.1ms、相同内容比较 0.6ms；单事件内部不能抢占，这个样本不构成任意超大事件的上限保证。复验使用实际 [历史投影](../src/history-projection.ts)、[校准集成回归](../test/session-calibration.test.ts)的隔离 Service 和上述数据规模、时序与采样方法；临时预览不作为生产路由或第二套 renderer 交付。

Figma 已同步并核验[首次加载](https://www.figma.com/design/qr0diiu1SH2prMVmhqMrJ0?node-id=4360-4736)、[缓存命中／后台校准](https://www.figma.com/design/qr0diiu1SH2prMVmhqMrJ0?node-id=4360-4772)及[校准失败](https://www.figma.com/design/qr0diiu1SH2prMVmhqMrJ0?node-id=4360-4808)。校准和失败态保留输入区域、禁用发送；重试进入校准，再回到实时就绪态。原型中的自动过渡用于状态演示，不是产品新增的定时器。

2026-09-12 实时消息缺口恢复复验后，既有校准／失败画面保持不变；[Figma 画布外流程说明](https://www.figma.com/design/qr0diiu1SH2prMVmhqMrJ0?node-id=4469-160)同步了缺口触发、保留正文、禁用发送、补读后恢复及失败重试。首次加载画面未改动，技术代次信息不进入产品状态行。
