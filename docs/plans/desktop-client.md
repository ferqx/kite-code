# 桌面客户端首版设计与实施计划

状态：阶段 0、1 及阶段 2 的本机 macOS 稳定性验收已完成；用户确认暂缓正式发布。本文保留延后的签名、公证与分发实施依据；已交付事实与验证归位 desktop owner。

2026-09-12 桌面宿主已改为 Electron；本文中的 Tauri/Rust 选型、阶段 0 与原生结果只保留为迁移前设计和证据。当前架构、构建与宿主验收由[desktop owner](../../apps/kite-desktop/README.md)和[原生验收](../../apps/kite-desktop/docs/native-validation.md#electron-本机迁移验收)维护；未依赖宿主的产品体验目标与延后发布范围继续有效。

## 首轮验证后的日常体验方向

2026-09-07 用户确认初始首轮验证完毕，后续进入日常体验开发，并要求客户端功能与日常交互体验对标 Codex。当前工作对象为桌面客户端；首版验收范围是起点，首版中暂缓的功能不构成后续对标的永久上限。正式发布仍按既有安排延后。

用户进一步确认桌面产品名为 **kite**，**kite-code** 为 TUI 名称；桌面覆盖代码与日常其他工作，采用 shadcn/ui，并改善子代理可见性和大量任务的浏览。具体需求、Figma 稿件和已确认交互集中维护在[kite 界面与协作体验](kite-client-experience.md)。

对标同时检查功能覆盖与完成同一任务的操作体验：入口是否容易找到、输入是否顺手、过程与结果是否清晰、任务切换是否连续、等待或失败时是否知道下一步。首轮验证通过不能代表这些体验已经达到目标。

以下为后续核对顺序与需求基线，具体交互和实现方案按场景逐项收敛，尚未声明功能对齐完成：

| 优先核对场景 | 对标目标与核对内容 | 当前证据入口 |
| --- | --- | --- |
| 输入与阅读 | 发送/换行、中文输入法、焦点与快捷键、上下文添加、Markdown 与代码块、复制、流式阅读与滚动 | [主界面](../../apps/kite-desktop/src/main.tsx)当前使用 textarea 与纯文本 pre；优先处理每日连续对话体验 |
| 项目与会话 | 新建和继续、快速切换、搜索、重命名、归档、置顶、未读和任务状态、草稿保留 | 主界面已有基础会话导航；跨重启草稿仍是[手册限制](../handbook/clients/desktop/README.md) |
| 执行与交互 | 工具过程折叠、等待/完成/失败反馈、运行中补充要求、停止、审批、问题与计划审核 | [客户端 owner](../../apps/kite-desktop/README.md)已有基础执行与交互；新增控制行为先核实服务契约 |
| 检查开发结果 | 文件与代码差异阅读、定位与评论、编辑器跳转、终端及 Git 工作流 | [结果 owner](../../apps/kite-desktop/docs/results-and-editor.md)当前展示文件工具记录；完整工作区 diff 与任务修改归属须分别核实 |
| 模型、设置与扩展 | 设置入口与生效反馈、模型切换、Skills/MCP 的发现与使用 | 当前配置与能力见桌面 owner；复用现有配置和扩展 owner |
| 持续工作 | 重启继续、后台状态与通知、多任务和 worktree、自动化、远程能力 | 当前生命周期与历史见桌面手册；按本地日常收益与现有服务边界确定后续实施顺序 |

整体目标与实施边界已经归入[界面与协作体验](kite-client-experience.md)。后续实施按以下顺序推进，每一阶段先核实生产数据与控制契约，再实现对应画板，不从视觉样例反推服务能力：

1. 保持 Current 行为完整：项目与信任、Provider/模型、会话、流式过程、审批、问题、计划审阅、停止、重连、历史和文件工具结果。
2. 完成高频 Next 体验：任务搜索与预览、富文本输入与阅读、持久草稿、后台状态、统一执行详情和验证证据。
3. 接入结果工作区：分别核实文件记录、工作区变化、Git diff、Terminal 与 Review 的 producer、归属和失败行为。
4. 完成 Subagent 桌面协作：摘要、详情、等待依赖、失败影响、取消与交接均消费 Runtime 真值。
5. 补齐恢复与扩展管理：把断线、重试失败和恢复同步作为会话消息呈现，并补齐上下文连续性、MCP、Skills 与连接诊断；Vision 的跨项目、远程和自动化另行取得需求与运行证据。

参考核对日期为 2026-09-07：[Codex 官方功能入口](https://developers.openai.com/codex/app/features)与[官方命令和快捷键](https://developers.openai.com/codex/app/commands)。两者当前重定向至 OpenAI 的共享文档；其中会话管理、导航、模型选择、文件和审阅入口可作为核对线索。共享页面中的 ChatGPT 专属项不直接算作 Codex 功能，具体版本、平台、可用条件和操作细节在对应迭代中核实。上表包含 Kite 的体验验收要求，不表示每一项已取得 Codex 的实测证据。

每项迭代记录 Codex 参考行为、Kite 当前行为及证据、目标行为和验收场景；区分缺少能力与已有能力的体验缺陷。桌面 presentation 的局部改进沿现有 owner 实施；涉及服务、状态、持久化或权限时再补充实际受影响契约，不预建通用框架。验收覆盖正常操作及相关切换、失败、取消和恢复场景；原生交互使用真实桌面证据，接口或组件测试只证明其覆盖部分。已交付行为同步手册与 owner。

## 目标与范围

桌面端提供可日常使用的本地开发入口：安装后选择项目、配置模型、发起任务、处理交互、检查结果，并在再次打开时继续会话。使用 Tauri 2、Rust 宿主、React、TypeScript 与 Vite；执行继续使用现有 App Server 和 Runtime。首个验收平台为 macOS，其他平台需取得各自安装、WebView、原生执行与生命周期证据后再承诺支持。

首版覆盖：

- 项目选择、工作区信任、Provider 凭据输入、模型选择与必要设置。
- 新建及继续会话、历史浏览、输入草稿、流式回答与工具过程。
- 工具审批、补充问题、已有计划审核交互、取消与失败提示。
- 任务结果、代码变更阅读及在外部编辑器中打开文件。
- 关窗后继续执行、明确退出应用时收尾、重新打开后的历史恢复。

完整编辑器、内置终端、Git 写操作中心、云同步、远程执行、自动 worktree、独立多窗口、自动更新服务和显式共享 daemon 接入暂缓。 客户端与 TUI 当前不建设账号注册或统一用户登录；后续远程控制接入时再设计身份认证，遵循[共享产品边界](../handbook/README.md#产品边界)。Provider 凭据与可选 MCP OAuth 继续由原 owner 处理，不扩展为 Kite Code 账号体系。桌面端不要求首版复刻所有 TUI 命令；恢复点与分叉等高级入口另按实际需要安排，不自动继承 TUI 的全部能力。

当前本机开发版本的已实现职责与验证限制见[桌面 owner](../../apps/kite-desktop/README.md)，当前用户入口见[桌面手册](../handbook/clients/desktop/README.md)。未完成的首版能力继续由本文维护。

## 当前证据与接入约束

| 现有能力 | 证据与桌面端影响 |
| --- | --- |
| 浏览器 Web 是只读入口 | [Web owner](../../apps/kite-web/README.md)；可复用合适的样式与纯展示组件，不能把 REST/轮询当作桌面端执行链路 |
| Runtime Client 与载体解耦 | [Client owner](../../packages/runtime-client/README.md)、[transport 接口](../../packages/runtime-client/src/index.ts)、[browser 构建](../../packages/runtime-client/package.json)；优先保留请求关联、订阅、generation 和恢复语义 |
| Native composition 依赖 Node/Bun | [App Server client](../../packages/kite-local-runtime/src/client/app-server-client.ts)、[stdio transport](../../packages/kite-local-runtime/src/client/bun-stdio-child-transport.ts)；不能原样导入 WebView 或由 Rust 直接执行 TypeScript |
| App Control 已有闭集契约 | [App Control adapter](../../packages/kite-local-runtime/src/client/protocol-app-control.ts)、[契约包](../../packages/kite-app-contract/package.json)；需要分离环境无关组合，避免在 Rust 重写领域 codec |
| 服务与持久会话分属不同 owner | [App Server 契约](../active/app-server-local-runtime.md)、[生命周期计划](daemon-upgrade-lifecycle.md)；沿用自有 child、同 build 配对、Store fencing 与失败处理 |

Tauri 官方提供 [Rust/Core 与 WebView 进程分工](https://v2.tauri.app/concept/process-model/)、[sidecar 打包](https://v2.tauri.app/develop/sidecar/)和 [IPC capability](https://v2.tauri.app/security/capabilities/)机制。采用这些机制不意味着现有服务制品、沙箱、凭据或退出行为已经通过 Tauri 验证，也不承诺整个应用的安装体积与一个空 Tauri 壳相同。

## 技术边界与验证方向（Tauri 历史）

迁移前曾采用以下组合，并完成当时宿主的本机原生窗口、IPC 与生命周期验收；这些结果不授予 Electron 或正式发布资格：

```text
React presentation / desktop adapter
    → 纯 TypeScript Runtime Client + App Control codec
    → 桌面专用 transport（受限 Tauri IPC）
    → Rust 宿主（固定配套制品、进程与 stdio）
    → App Server（Runtime / History / App Control）
    → 现有 Host / Kernel / Store
```

这里的 typed client 运行在桌面 WebView 的客户端适配层，Rust 拥有操作系统资源。Rust 不运行 TypeScript，不重写 Runtime Client 的领域状态机，也不新增一个仅为运行 client 的 Node/Bun 中转进程。浏览器 Web 的依赖与权限保持现状。

当时的 `apps/kite-desktop` 组织前端 presentation、桌面 adapter/transport 与 Tauri 宿主。当前宿主已迁到 [Electron host](../../apps/kite-desktop/electron/host.ts)，renderer 仍只消费可安全构建的协议组合入口；现有 TUI/CLI 接口继续工作，不能依赖对含 Node/Bun 模块的根导出进行偶然 tree-shaking。Kernel 不依赖桌面或其他 workspace。

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

后续需要验证：正式签名、公证与分发升级、签名包的完整 MCP 原生凭据流程及其他平台；本机长会话、多客户端竞争和未签名手动替换的结果见下方阶段 2 状态。遇到无法满足已确认行为的问题，应先在现有 owner 内调整实现；实质改变产品范围或生命周期时再提交具体决策。

过度设计核对：必需的是桌面宿主、受限传输、现有 client/service、展示和偏好；不建设第二套会话 authority、协议状态机、服务管理器或持久重试队列。其余首版外能力延后且不建立脚手架。


## 阶段 0、1 完成与后续

阶段 1 当前迭代已接入 Provider 写入与模型选择、问题和计划交互、按工作区过滤的会话目录、显式项目切换、文件工具变更阅读及受限外部编辑器跳转。真实 DeepSeek 经 App Server 完成代码写入、测试和重启后继续会话；自动检查覆盖配置不重放、计划正文及身份、项目隔离与迟到响应。解锁后已通过真实原生窗口完成配置替换、问题、计划反馈与批准/取消、项目与会话草稿、实际文件修改与测试、结果阅读、VS Code 文件打开及冷启动继续。阶段 1 完成本机 macOS 日常开发闭环；外部 Provider 服务证据与本机 fixture 的原生证据分别归位，不互相替代。

阶段 0 已完成本机 macOS 接入与安装纵切，证据归位[原生验收](../../apps/kite-desktop/docs/native-validation.md)：真实目录选择、信任、流式任务、关窗继续/重新激活、取消、断开确认/重连、正常退出、重启历史及宿主崩溃后受控工具进程树清理均已核实。复制到源码外的 `.app` 在仅系统 PATH 下启动并使用包内服务。

原生验收修复了同步 confirm 误用、Cocoa Quit 绕过确认、确认框未绑定主窗口、跨项目旧选择残留及工具取消终态展示。为完成真实工具场景已接入单次审批/拒绝；不据此宣布完整交互系统已交付。加载会话有明确提示和超时，重连不重发 mutation。

阶段 2 的本机稳定性结果和待验证限制见下文；正式发布工作按当前用户安排延后。

阶段核对保留必要宿主、受限 IPC、有界队列、原生退出适配和单一协议组合；没有中转进程、第二套服务管理器、持久操作队列或额外 UI 框架。阶段 0 本机通过不扩大为正式发布资格。

阶段 2 已完成本机稳定性迭代：固定 source sequence 的历史分页、回执丢失后副作用不重放、通道压力、实际原生长会话渲染、桌面与安装版 TUI 的同会话 fencing、缺失/损坏制品拒绝，以及手动替换应用的数据保留。修复安装版 TUI 会话选择器的生产 JSX 依赖缺陷；源码与 standalone 原生凭据 smoke 均通过。具体环境和证据边界归位[原生验收](../../apps/kite-desktop/docs/native-validation.md)。

当前安排：用户确认暂不急于发布，现阶段以本机开发和内部测试为主。阶段 2 的本机稳定性迭代已完成；正式签名、公证、下载后 Gatekeeper 与正式分发升级延后，缺少 Apple 签名身份不再阻塞当前开发和未签名测试版使用。待启动正式发布时再确定团队、证书和渠道并完成发布验收，不能以未签名手动替换替代。

最终包内 Service 已通过自身 OAuth 登录、原生 Keychain 保存及重启恢复，完成当前本机凭据生命周期验收。其他 executable 创建的凭据导入仍可能需要系统授权，未承诺无提示迁移；正式签名包需重新验证。具体测试前提与限制见原生验收记录。

签名实施前的具体约束：若采用站外分发，使用 Developer ID Application 身份，按 [Tauri 签名说明](https://v2.tauri.app/distribute/sign/macos/)完成公证与票据装订；商店渠道需要单独核实能力与沙箱要求。配套 Bun executable 的签名会改变文件字节，因此必须先签服务，再计算候选 checksum 和桌面嵌入 manifest，最后签宿主/包，禁止在 manifest 固定后改签服务。发布路径仍需实现这一顺序并复验。Bun JIT 和原生 addon 的 hardened runtime 权限须按实际签名包验证最小集，参考 [Bun 签名文档](https://bun.sh/guides/runtime/codesign-macos-executable)，不能未经验证复制全部权限。当前未加入无身份可验的签名流水线或权限脚手架。
