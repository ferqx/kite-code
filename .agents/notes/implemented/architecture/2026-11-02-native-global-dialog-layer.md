# Agent Note: 全局确认使用专用原生浮层与统一应用 UI

Status: implemented

## Problem

网页由 Main 的 WebContentsView 绘制在 Root 上方，Root DOM 的 z-index 无法盖住它。通用菜单、选择器或全局弹层触发网页撤下，会让仍应可见的网页变成应用空底；aria-hidden 与 inert 还会把无相交的选择器误判为视觉隐藏。用户明确要求移除这一策略，并确认全局对话框应采用同一主窗口内、原生层级高于网页的应用自绘浮层，保持各平台 UI 一致。

用户另明确要求失败反馈不弹“操作未完成”对话框，改用能理解原因的临时 message。该提示不能批准权限、重试未知执行、改变原任务结果或替代原命令核对。

## Decision

正常主窗口中的完全权限与移除空间确认，共用一个 Main 所属的专用 WebContentsView。退出应用按用户最新要求保留系统原生弹窗，Overlay 不再接受退出 kind。完整层序为 Root ＜ Page ＜ 浏览器受控输入屏障 ＜ 应用全局浮层。所有 Page 与 shield 插入都经过保留浮层最高位置的入口；shield 不因浮层在最上而反复排序，也不把焦点抢回 Root。

浮层只加载构建产物中的 global-dialog.html、专用 preload 和同一套共享 AlertDialog、CSS 与字体。背景透明，遮罩覆盖完整内容区，原网页保持真实可见，不导航、刷新、复制截图或调整网页 bounds。主题跟随 Main 的实际主题；自绘确认按钮、布局和风险文案由共享组件维护。退出确认、目录／文件选择器保留系统行为；启动致命失败或主窗口已不存在时，原无法依附应用浮层的系统路径仍保留。

Root IPC 仍只提交准确请求 ID 与固定语言的 Full 确认。Main 校验准确 Root、主 frame、URL、父窗口和在途 owner；专用 Renderer 只能接收有限 kind 的状态并返回同一 requestId 的决定，没有 Service、浏览器、文件或通用 HTML 执行桥。空间名称按文本呈现，不能成为 HTML。两类自绘确认共用一个 modal owner；退出请求先退休旧自绘确认，再沿原生退出流程，旧肯定结果不能落到继任者。

Root 的准确应用节点在 modal 期间 inert，Main 只拦截 Root 的 before-input／before-mouse 事件。Page 的这些事件也接收授权 CDP 输入，不能统一 preventDefault；人工鼠标由最高原生 Overlay 命中，人工键盘由浮层焦点与 DOM 模态约束，Page 授权输入继续沿原 lease／控制门禁。显式焦点操作仅在父窗口仍 focused 时执行，后台取消不重新激活客户端；重新激活时当前浮层接回焦点，隐藏浮层不再参与 Root 的焦点目标选择。关闭后仅在父窗仍 focused 时恢复仍属于同一主窗口、仍可见、文档未替换的原 WebContents；隐藏、最小化、Root 导航／崩溃／销毁、overlay 崩溃或请求取消都退休当前决定。崩溃的 overlay 可以在下一次请求重新创建。当前取消不等待首帧，肯定决定仍需presented；初始化或提交失败不构成确认；父窗口仍在的原生退出确认失败保留服务，并发送有限的可读临时消息；无主窗口的失败保留原退出契约。

预热 view 平时隐藏；发起确认时，冷启动与预热未 ready 的 view 都立即以完整尺寸、最高原生层级显示透明背景并承接人工输入，再等待共享 Dialog 提交后的 presented 通知，避免加载空档和依赖隐藏 Chromium view 的 rAF。Dialog DOM 尚未加载时没有取消按钮或 Esc 处理器；当前 false 不等待 presented，只说明已有决定的准入，不承诺整个加载阶段物理 Esc 可立即处理。通知用于当前 dialog 的决策准入，不是 WindowServer 像素回执，也不恢复被删除的浏览器 ACK／witness 或截图交接。网页绘制与 UI 实际过程仍分别核证据。

Full 的有效确认继续交给原 Composer／权限控制器，新对话只修改本地待创建偏好；空间移除仍在确认后核新鲜空间身份并沿原 journal／命令提交；退出沿原 ownsQuit 与服务清理控制器。Overlay 自身不执行这些业务动作，不改变工具、服务协议或依赖版本。

旧“操作未完成”AlertDialog 已移除。现有展示范围内的失败以聊天区域的临时 message 呈现，约六秒、hover／focus 暂停、可以手动关闭；每次 occurrence 有独立身份，旧计时器、旧按钮及未提交的 React 渲染不能清除新消息。错误只映射为有限可读说明；结果未知要求先核原操作，不诱导重复提交。普通、迟到或退出中的读取仍沿原归属门禁，不因此新增提示。设置内真实错误继续行内呈现。

## 与既有决定的关系

本决定部分替代[固定 Renderer Note](2026-11-02-browser-fixed-renderer-layout.md)的通用弹层撤页方案。其 Root／Page 单一 owner、准确原页身份、受控输入屏障、首文档绘制准入、取消与页面保留继续适用。本 view 仅承载应用确认，未恢复旧浏览器 Chrome Renderer、工具栏副本或浏览器布局交接。

## Alternatives considered

- 仅提高 Root DOM z-index：无法跨原生子视图排序，不能覆盖网页。
- 弹框时撤下网页或用截图替代：不满足用户保留真实网页的要求，且扩大截图身份、期限与恢复语义。
- 主窗口所属系统 message box：070／071 曾沿该方向准备与验证，能位于网页上，但用户随后明确选择应用自绘以统一各平台样式，已撤销该 Full 路径；失败材料保留。
- 为每个确认另开窗口：会引入窗口激活、位置与独立焦点管理；用户选择同主窗口的专用浮层，采用原生子视图排序。
- 把所有临时反馈也变成模态确认：违反用户对失败 message 的明确要求，也会无故打断阅读和操作。

## Consequences

构建增加专用 HTML、Renderer 和 preload；普通及 development 都生成静态 overlay 资源，Root 原 index.html／renderer.js 不变。现有完整 app manifest 已收录并校验全部新增资源，不升级工具或 bundle 格式版本。

源码、聚焦回归、实机动作与画面分别提供不同资格。073 已核 Full 三轮、真实遮罩输入阻断、焦点与原页保持；074在run前因退出竞态退役，075用最终制品补核空间长说明与真实取消；审看限连续前六秒及稳定尾，不扩称整片。随后补提前取消、Root-only输入拦截、冷启动透明覆盖和前台焦点约束，并让 Root 排除隐藏焦点目标；这些行为用定向回归及076c实际Electron输入补核：旧Host吞掉已返回ACK的Page CDP鼠标，修复后键鼠到达而Overlay维持native focus；物理mask点击在Overlay＋1、Root／Page为0，取消和准确原页状态保持。load前仅核原生visible／全bounds／top，未扩大为空DOM物理输入或整体像素资格；精确范围仍归Desktop owner。退出改回原生后删除 Overlay 的退出分支；Full／空间的文案、DOM 与 CSS保持，复用075正常开关画面，不称所有UI资产逐字未变。各平台实际窗口、活动工作退出的真实展示及临时消息自然失败路径的资格，只以[Desktop owner](../../../../apps/desktop/README.md#固定-renderer-布局收敛2026-11-02)记录为准，不由共享代码或最终截图推导。旧 resize、收展及重开反例继续保留，本决定不构成整个浏览器视觉收敛完成。
