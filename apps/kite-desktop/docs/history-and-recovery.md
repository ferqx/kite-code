# 历史目录与连接恢复

产品行为见[桌面手册](../../../docs/handbook/clients/desktop/README.md)。[DesktopClient](../src/client.ts)负责查询与恢复，[App](../src/App.tsx)负责选中空间和执行项目之间的交接。

## 不依赖项目环境的历史

启动首先接入原生宿主持有的 App Server；没有服务时可以不指定执行工作区启动。目录、持久会话投影、订阅初始快照与历史均从同一 profile Store 读取，不解析旧项目的文件系统，不要求 Git、模型配置或 Workspace Trust 可用。模型、项目和分支读取在目录之外完成，各自报错；失效路径仍可阅读历史，发送前才验证已登记目录的规范路径和信任。

目录使用 `history/list_sessions` 的轻量摘要与持久 Workspace membership，不请求所有会话完整投影，也不依靠逐项目 Trust identity 查询归组。已登记规范路径的文本摘要仅用于将 Store workspaceDigest 映射到本地选择记录，不授予权限；未登记的持久空间仍显示历史。每个空间独立读取 100 条，额外读取 profile 目录以发现未登记空间；最多八个并发读取，单个响应即可更新对应列表，下一页沿各自 cursor 继续。一个空间失败保留已有行并显示局部错误。刷新保持已有行顺序，所选实时投影覆盖旧摘要；无后台全会话订阅。

只读目录请求有 10 秒边界，可重试一次；明确不可重试错误不会重试。选择会话的查询、订阅 ready 与历史加载共用 20 秒边界，加载完成前禁止发送。选中代次隔离迟到结果；同会话恢复失败保留已读正文。

## 启动页

[App](../src/App.tsx)在首次挂载期间只显示启动页，等待项目列表读取、原生连接、首屏目录与当前项目准备检查结束；保存的选中会话也先完成恢复尝试。`restoreWorkspace` 等待已有 workspace preparation，分支检查与 Trust／模型读取均先取得结果或局部错误。无模型、失效目录与单个目录失败保留既有局部处理，不成为历史阅读门禁。连接失败或目录完全不可读时提供显式重试；重试复用健康 Service，并在此前目录尚未成功时重新读取，不启动第二个服务。

启动状态仅由本次页面挂载持有，不新增持久状态、延时或后台进程。准备完成后直接挂载共享主页面；窗口 focus／visibility 恢复监听只在主页面已进入后运行，后续断线不会切回启动页。样式在 [startup.css](../src/startup.css)，启动隐藏、失败重试、空目录和断线保留草稿由 [UI 测试](../test/ui.test.tsx)覆盖。启动页不代表 300ms 性能目标已经完成。

## 阅读与执行项目

点击任意空间的已有会话只切换读取与订阅，不关闭原 Service，不停止正在执行的任务。同一执行项目下继续会话直接提交给 Service，不重复执行项目选择与目录预检；Service 保留实际执行条件与授权核对。草稿按选中空间与会话隔离。显式选择新对话项目或向其他空间实际发送时先验证目录，再检查当前 Service 是否有活动任务；有活动任务才确认停止，之后等待旧服务清理、激活并授权明确选择的项目、重新读取会话后发送。当前 Service 仍只持有一个执行工作区；历史 membership 不授予跨工作区写权限。普通资料目录可执行，无须 Git；分支功能仅适用于 Git 仓库。

## 自动重接与未知结果

完整页面刷新复用原生 protocol peer，详见[原生连接恢复](new-conversation.md#页面刷新与连接恢复)。传输关闭或断开时立即撤销 ready，由唯一内部恢复循环重新接入，间隔依次为 250、1000 毫秒，此后上限为 3000 毫秒，直到恢复或当前生命周期结束。恢复选中会话的快照、订阅和历史，不以窗口聚焦或用户点击为触发条件。项目／分支切换和退出取消待执行的恢复，并等待正在接入的尝试结束后关闭当前服务，避免迟到恢复与下一项目争用进程。

主界面不展示本地服务的连接状态、重连／断开操作或未就绪提示。恢复期间保留已读消息、空间列表与草稿，禁止使用旧 ready 发送；内部连接错误不写入正文提示，也不冒充项目、目录或模型错误。未知命令结果仍明确提示用户检查实际效果，不以恢复成功掩盖未知结果。首次启动失败仍在独立启动页处理，恢复机制不绕过制品验证，也不自动替换损坏的安装文件。

客户端 transport close 只调用 `runtimeDetach`，取消旧页面的接收与订阅，不关闭 Service stdin。只有明确执行项目／分支切换与退出才调用 `runtimeClose` 关闭自有 Service。宿主已有健康 Service 时复用；确已退出才允许重新启动，不能承诺恢复已停止的执行。命令回执丢失仍保留“结果未知”提示，自动恢复不会重放创建、发送、审批、配置或 Git 命令。

## 验证

[导航集成测试](../test/navigation.test.ts)使用真实 Service 验证失效目录和模型配置下读取历史、跨空间只读与执行限制、局部失败和旧响应隔离；[恢复测试](../test/resilience.test.ts)验证写入后丢失回执的自动恢复与不重放；[配套 Service 测试](../test/host-paired-service.ts)驱动 Electron host 与真实 stdio Service，[renderer 连接测试](../test/host-renderer-connection.test.ts)覆盖 detach、reattach、initialize 复用和旧代次隔离。SQLite [目录测试](../../../packages/runtime-storage-sqlite/test/kite-home-directory.test.ts)覆盖超过千条记录的有界分页、稳定 membership 与空间过滤。这些测试不替代 Electron 窗口、preload 与系统输入法的原生验收。

本地目录的存在状态由 `listProjects` 读取时查询，不写入项目偏好。目录缺失只让空间名称使用次级文字色，不显示“尚未关联本地目录”常驻提示，也不据此禁用会话。返回已连接窗口只更新本地目录状态，不重新查询会话目录；历史目录在连接、新建与所订阅运行结束时更新，未订阅的外部变化可能延迟到下次目录读取。


## 启动预算与验证边界

连接与首屏目录的目标预算为 300ms。启动链路只打开和核对 Store 文件、格式与结构，读取有界目录；完整会话恢复检查按目标 Session 在同一 SQLite read snapshot 内完成，Artifact 内容由所属 reader 在访问时校验。显式 release preflight 仍执行完整 SQLite physical/FK 检查，不把此全库维护工作重复放进各个 reader 构造函数。跨包约束见[SQLite Runtime Log](../../../docs/active/sqlite-runtime-log-query.md)。

Electron 宿主在每次新建配套进程前读取并校验完整 Service SHA-256；摘要与 expected server version 来自构建时编入 main bundle 的已验证清单，不从运行时资源清单换版本，也不改成未经校验的文件缓存。Builtin 的 tokenizer 在第一次计数时加载，历史浏览不初始化词表。

2026-09-11 Tauri 开发构建曾使用本地数据库的隔离副本测量：268,935,168 字节、2 个空间、85 个会话、24,889 条事件。优化后空闲环境下 5 次“完整程序校验 → 新建 Service → initialize → 100 条首屏目录返回”为 231、187、190、194、190ms；同一 Service 的 renderer 重接与目录读取为 3、3、3、3、6ms。新进程测量复用了 OS 文件页缓存，不等于清空系统缓存后的磁盘冷启动；当时刚构建的 Service 在无并发浏览器操作时首次运行仍观测到 611ms，并发启动浏览器的一次观测达到 650ms。这些数字只说明 Service 与历史负载的既有基线，不能当作 Electron 冷启动或端到端资格。

另用实际 App／共享组件与 85 条隔离展示数据，在内置浏览器两次 requestAnimationFrame 后核对 85 行已提交，观测为 47ms。此项与原生服务计时分开，不能相加并宣称已经取得 Electron 从系统启动到窗口绘制完成的端到端资格。当前 [host lifecycle 测试](../test/host-lifecycle.test.ts)、[配套 Service fixture](../test/host-paired-service.ts)与待完成的 packaged Electron smoke 分别核对宿主、真实执行和窗口链路；成功证据取得前，300ms 端到端目标仍未满足。
