# 桌面客户端首版设计与实施计划

状态：阶段 0 已完成；产品方向与 Tauri 技术路线已确认。本文保留后续实施依据；已交付事实与验证归位 desktop owner，未交付的开发与发布能力继续按下列阶段推进。

## 目标与范围

桌面端提供可日常使用的本地开发入口：安装后选择项目、配置模型、发起任务、处理交互、检查结果，并在再次打开时继续会话。使用 Tauri 2、Rust 宿主、React、TypeScript 与 Vite；执行继续使用现有 App Server 和 Runtime。首个验收平台为 macOS，其他平台需取得各自安装、WebView、原生执行与生命周期证据后再承诺支持。

首版覆盖：

- 项目选择、工作区信任、Provider 凭据输入、模型选择与必要设置。
- 新建及继续会话、历史浏览、输入草稿、流式回答与工具过程。
- 工具审批、补充问题、已有计划审核交互、取消与失败提示。
- 任务结果、代码变更阅读及在外部编辑器中打开文件。
- 关窗后继续执行、明确退出应用时收尾、重新打开后的历史恢复。

完整编辑器、内置终端、Git 写操作中心、云同步、远程执行、自动 worktree、独立多窗口、自动更新服务和显式共享 daemon 接入暂缓。桌面端不要求首版复刻所有 TUI 命令；恢复点与分叉等高级入口另按实际需要安排，不自动继承 TUI 的全部能力。

当前阶段 0 的已实现职责与验证限制见[桌面 owner](../../apps/kite-desktop/README.md)，当前用户入口见[桌面手册](../handbook/clients/desktop/README.md)。未完成的首版能力继续由本文维护。

## 当前证据与接入约束

| 现有能力 | 证据与桌面端影响 |
| --- | --- |
| 浏览器 Web 是只读入口 | [Web owner](../../apps/kite-web/README.md)；可复用合适的样式与纯展示组件，不能把 REST/轮询当作桌面端执行链路 |
| Runtime Client 与载体解耦 | [Client owner](../../packages/runtime-client/README.md)、[transport 接口](../../packages/runtime-client/src/index.ts)、[browser 构建](../../packages/runtime-client/package.json)；优先保留请求关联、订阅、generation 和恢复语义 |
| Native composition 依赖 Node/Bun | [App Server client](../../packages/kite-local-runtime/src/client/app-server-client.ts)、[stdio transport](../../packages/kite-local-runtime/src/client/bun-stdio-child-transport.ts)；不能原样导入 WebView 或由 Rust 直接执行 TypeScript |
| App Control 已有闭集契约 | [App Control adapter](../../packages/kite-local-runtime/src/client/protocol-app-control.ts)、[契约包](../../packages/kite-app-contract/package.json)；需要分离环境无关组合，避免在 Rust 重写领域 codec |
| 服务与持久会话分属不同 owner | [App Server 契约](../active/app-server-local-runtime.md)、[生命周期计划](daemon-upgrade-lifecycle.md)；沿用自有 child、同 build 配对、Store fencing 与失败处理 |

Tauri 官方提供 [Rust/Core 与 WebView 进程分工](https://v2.tauri.app/concept/process-model/)、[sidecar 打包](https://v2.tauri.app/develop/sidecar/)和 [IPC capability](https://v2.tauri.app/security/capabilities/)机制。采用这些机制不意味着现有服务制品、沙箱、凭据或退出行为已经通过 Tauri 验证，也不承诺整个应用的安装体积与一个空 Tauri 壳相同。

## 技术边界与验证方向

当前已采用以下组合；本机原生窗口 IPC 与生命周期验收已完成，正式发布资格仍按后续阶段验证：

```text
React presentation / desktop adapter
    → 纯 TypeScript Runtime Client + App Control codec
    → 桌面专用 transport（受限 Tauri IPC）
    → Rust 宿主（固定配套制品、进程与 stdio）
    → App Server（Runtime / History / App Control）
    → 现有 Host / Kernel / Store
```

这里的 typed client 运行在桌面 WebView 的客户端适配层，Rust 拥有操作系统资源。Rust 不运行 TypeScript，不重写 Runtime Client 的领域状态机，也不新增一个仅为运行 client 的 Node/Bun 中转进程。浏览器 Web 的依赖与权限保持现状。

已新增 `apps/kite-desktop`，内部组织前端 presentation、桌面 adapter/transport 与 `src-tauri` 宿主。只有接入证明需要时，才在现有 Native owner 下分离可安全构建的协议组合入口；现有 TUI/CLI 接口继续工作，不能依赖对含 Node/Bun 模块的根导出进行偶然 tree-shaking。Kernel 不依赖桌面或其他 workspace。

Rust 宿主固定服务 executable、build、profile、canonical workspace 与环境，WebView 只能通过已注册的桌面能力操作当前连接。IPC 不暴露任意 executable、shell、环境变量、数据库、凭据读取或任意路径访问；外部编辑器跳转使用校验后的明确文件目标。Tauri capability 约束本地窗口入口，Service 继续校验协议、信任与授权；两者不互相替代。工具输出、Markdown 和链接按不可信内容渲染，不授予远程页面本机 IPC 权限。

transport 只负责当前连接的有界消息传输、顺序与关闭，不拥有第二份请求重试或业务状态。阶段 0 验证 stdio 分帧、大小限制、压力下背压、IPC 订阅安装顺序、连接代次与关闭语义；如通道溢出必须显式断开并走现有重同步，不能静默丢失终态或审批。限额优先沿用现有协议约束。握手仍核对同 candidate/build 及所需方法，Rust 不能自行推断 ready。

## 产品流程、数据与状态

初次启动显示项目选择与连接进度；选定项目后启动配套服务，经现有 App Control 完成配置与信任。启动进程不等于信任工作区；完成握手与必要状态加载后才开放任务提交。凭据只经精确写入接口提交，不回读明文，不进入日志、浏览器持久存储或通用界面状态；输入控件提交后释放临时值。

主界面包含项目/会话导航、任务对话、按需展开的结果与变更查看，以及设置入口。审批与问题在所属会话中明确展示等待、提交中、成功或失败；正在提交时防止重复触发。模型、任务与工具状态以服务投影为准，不能把回答文字结束当作执行完成。

| 状态或数据 | 归属与要求 |
| --- | --- |
| Session、Run、执行、审批、历史 | 现有服务与 Store；不新增桌面任务表或持久操作队列 |
| 客户端连接与投影 | 复用 Runtime Client generation、订阅及 snapshot；界面保留显示缓存但不得用旧 ready/revision 提交命令 |
| 选中会话、展开项、输入草稿 | 桌面 presentation；按 profile、workspace 与 Session/新会话草稿身份隔离，首版只承诺进程内断线与切换保留草稿 |
| 最近项目、窗口及界面偏好 | 桌面本地偏好；与 Service 配置分开，不保存执行真值或 Provider 密钥 |
| Provider、模型、信任配置 | 沿用 App Control 和原配置 owner，不建立桌面独立配置权威 |

首版采用单主窗口、一次连接一个工作区。切换会话是导航，不隐式取消原会话任务；迟到响应按原身份处理。切换项目时若旧项目仍有活动任务，应允许留在原项目或明确停止并等待清理后切换；不得静默终止执行或把旧连接响应投影到新项目。无活动任务时关闭旧自有连接，再为所选项目建立连接。跨项目并行不属于首版承诺。

代码变更查看须在实施时核实真实 producer：优先使用已有客户端可读结果；需要额外数据时由现有服务 owner 提供最小只读契约，不在 UI 直接读取 Store。当前工作区 Git diff 与本次任务造成的变更必须明确区分，不能把用户原有修改归给 Agent。尚无证据的文件、二进制或大体积内容应显示限制，不伪造完整覆盖。首版只读检查与外部跳转，不附带应用补丁或恢复写操作。

## 关闭、失败、取消与升级

- 关闭主窗口时隐藏并保留窗口与自有服务；再次激活显示原窗口。应用仍在运行，任务继续；不依赖隐藏 WebView 定时轮询维持执行，不自动应答待审批操作。阶段 0 必须验证隐藏后事件通道的实际行为。
- 明确退出应用时，有活动任务则提示用户选择返回或停止任务并退出；停止后等待现有取消与资源清理。不影响其他 TUI/daemon，不承诺应用退出后任务继续运行。
- 宿主崩溃或被终止时，依靠父子管道关闭及既有服务收尾语义处理；真实进程验证必须证明不会遗留受控工具执行。不能只根据窗口已关闭判定清理成功。
- 启动失败区分安装缺失/损坏、服务退出、版本、配置/信任与连接问题，提供可读、脱敏且有界的诊断；不能显示为空会话，也不搜索另一个 daemon 或 PATH executable 替代。
- 连接中断停止宣称任务正常运行，保留历史与进程内草稿，区分未提交、已确认与结果未知。用户明确重连时仍使用原固定制品；恢复订阅但不自动重发 mutation、审批或问题回答。
- 取消不是回滚。已有修改和外部副作用保留；结果未知时按[共享恢复语义](../handbook/features/recovery.md)展示并引导检查，不自动重新执行。
- 桌面安装包携带配套服务与所需原生资源，不要求用户另装 Bun、启动 daemon 或访问源码。打包复用现有 candidate/build 身份和校验职责，补充桌面宿主制品，不另建服务发现/升级管理器。
- 首版验证安装及显式升级路径。升级不得静默替换运行中服务或覆盖会话；退出旧应用完成清理后再运行新制品。回退必须遵循现有存储兼容约束，不能以替换应用包推断旧程序可读取新数据。

## 实施阶段与验收

| 阶段 | 交付与完成条件 | 文档交接 |
| --- | --- | --- |
| 0：Tauri 接入与安装纵切 | 验证纯 TS client 的 WebView 构建、受限 IPC、Rust 启动同包服务、握手、一次真实任务与流式结果；最小 macOS 安装包在无源码、无另装 Bun 环境运行；验证关窗继续、重新激活、退出及宿主异常清理。收敛 transport/导出位置、隐藏时事件交付、打包资源清单与原生依赖。未通过不得宣称接入完成 | 新 desktop owner README、必要 client owner/active 更新；只将已验证事实归位 |
| 1：日常开发闭环 | 项目选择/切换、信任与配置、会话历史、草稿、审批/问题/计划交互、取消、结果与变更阅读、外部编辑器跳转；完成一次真实修改与验证任务，再次打开能继续会话 | 新桌面手册、能力表、desktop 专题；如需要新的只读结果契约，同步实际 owner |
| 2：稳定性与首个平台发布 | 大会话与快速切换、提交结果未知、重连、通道压力、损坏制品、原生凭据、安装升级与数据保留验证；验证桌面与 TUI 同 profile/Session 竞争仍由既有 fencing 裁决；完成目标平台签名及分发验证 | 发布/运维、测试入口、受影响 active；用户限制进入手册 |

阶段 0 开始即建立真实桌面与子进程证据；浏览器组件测试不能替代原生窗口、IPC 和安装包验收。每阶段根据修改执行类型、边界、相关单元/集成和实际桌面场景检查。平台资格按测试环境明确记录，不用 macOS 成功替代 Linux/Windows 结果。

每阶段完成执行 `iteration_complete` 和 overengineering-check，后续阶段沿已确认设计推进。本文不设置未经实测的工期或内存/体积数字；阶段 0 结果用于估算剩余工作。

## 设计核对与剩余验证

已确认：桌面完整交互入口、Tauri 路线、现有服务复用、首版范围、macOS 优先和分阶段交付。单窗口、IPC/transport 与连接组织已采用 desktop owner 中的组合，具体已交付职责以 owner 与 active 为准。

后续需要验证：正式签名与升级、代码变更只读数据来源、完整配置/交互、长会话及其他平台。遇到无法满足已确认行为的问题，应先在现有 owner 内调整实现；实质改变产品范围或生命周期时再提交具体决策。

过度设计核对：必需的是桌面宿主、受限传输、现有 client/service、展示和偏好；不建设第二套会话 authority、协议状态机、服务管理器或持久重试队列。其余首版外能力延后且不建立脚手架。


## 阶段 0 完成与后续

阶段 0 已完成本机 macOS 接入与安装纵切，证据归位[原生验收](../../apps/kite-desktop/docs/native-validation.md)：真实目录选择、信任、流式任务、关窗继续/重新激活、取消、断开确认/重连、正常退出、重启历史及宿主崩溃后受控工具进程树清理均已核实。复制到源码外的 `.app` 在仅系统 PATH 下启动并使用包内服务。

原生验收修复了同步 confirm 误用、Cocoa Quit 绕过确认、确认框未绑定主窗口、跨项目旧选择残留及工具取消终态展示。为完成真实工具场景已接入单次审批/拒绝；不据此宣布完整交互系统已交付。加载会话有明确提示和超时，重连不重发 mutation。

阶段 1 继续实现模型配置、问题/计划交互、完整跨项目会话体验、结果与代码变更阅读、外部编辑器跳转。阶段 2 继续正式安装升级、签名/公证、长会话与多客户端资格。默认 profile 的全局目录、原生凭据库、真实外部 Provider 与非 macOS 平台的限制仍需按所属阶段解决。

阶段核对保留必要宿主、受限 IPC、有界队列、原生退出适配和单一协议组合；没有中转进程、第二套服务管理器、持久操作队列或额外 UI 框架。阶段 0 本机通过不扩大为正式发布资格。
