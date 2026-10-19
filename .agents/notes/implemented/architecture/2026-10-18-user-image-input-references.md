# Agent Note: 用户图片与路径引用分离

Status: implemented

## Problem

用户要求输入时渲染 Markdown，并区分两种附件：`+` 选取的文件只需引用路径，直接粘贴或拖入的图片必须实际进入模型输入。原模型协议只有文本；若只展示图片缩略图，模型并未收到图像。正文直接塞入命令、消息文本或 renderer 自报路径，又会混淆持久意图、文件读取权限和只读历史。

## Decision

2026-10-19 用户最终明确：`+` 只有“添加文件”，同一次多选自动区分图片和普通文件，两类附件统一横向列表展示，不内联正文。此前双入口是实现对协议分流的误解，已由单入口替换；二进制与路径的交接边界继续保留。普通文件名称与 URI 沿原 Command／Message 的独立 `files` 元数据保存；沙箱 preload 只从 Electron 真实磁盘 File 解析路径，不读取正文。Runtime 组装模型历史时追加低权限路径文本，由原 Files 工具核权限后读取，不自动加载外部说明。图片（选择、粘贴或拖入）交付原字节，Main 分块校验与暂存，按原 Store/Session 发布既有不可变 Artifact 后，把完整引用加入正式输入 journal。命令与消息只存引用，Runtime 核原出处、完整读取与摘要，再映射为中立 user 图片数据；AI adapter 只负责 Chat Completions 的 `image_url.url` 和 Responses 的 `input_image.image_url` 内联 Base64，不扩 Anthropic Messages。没有公网存储，不使用远程 URL 或 Provider file ID。不同窗口草稿 scope 和历史 reader 保各自资源。

2026-10-19 用户要求修复发送后图片默认不可见和回复期间抖动。历史 `loading` 是新读取的准入事实，不能同时充当附件组件的挂载条件：同一观察下保留卡片与已验证 URL，进入视区自动加载，切换或失去可见性才释放。为避免打开长历史时并发读取所有原图，采用 160px 预取范围和窗口级串行队列；代价是重回已释放区域需重新读取，缩略图不再要求逐张点击。Main 原出处与完整校验边界保持。

实时 Markdown 使用 Lexical，源文仍作为宿主草稿交接；未编辑的外部草稿保留原字节，编辑后按 Markdown 序列化，撤销不跨会话。这使原文本保存和未知回执查询继续复用原链路。

## Alternatives considered

- 所有文件都上传二进制：普通文件继续只引用路径；同一入口自动把图片交给原图协议，没有扩展 PDF 模型协议。
- 图片与普通文件提供两个选择入口：曾实现，但用户明确要求统一“添加文件”；界面不要求用户理解模型协议，类型分流由实际文件决定。
- 所有附件都变为路径：符合文件选择，但不能满足直接图片交给视觉模型的要求。
- base64 填入文本命令／SQL 消息：会让图片冒充自然语言、扩大原意图正文并重复写入历史；改用已有 Artifact 元数据和完整 reader。
- 文件引用继续拼进 Markdown 草稿：原方案已实现过；后续用户要求附件独立列表及正文保持，因此改为消息 source JSON 元数据，不通过解析用户 Markdown 隐藏路径来伪造独立附件。
- 整图同步 Base64 或并发准备所有图片：会放大 renderer 内存和阻塞；选择原生异步 32KiB 编码、跨批次串行及读取前窗口总量预留，不改变原图质量。
- Markdown 编辑／预览切换：用户选择边输入边渲染，因此采用实际富文本编辑器，而不叠加只读预览覆盖层。

## Consequences

增加闭合图片上传 API、可选 InputImage／InputFileReference 元数据、Native 用户字节暂存／已观察消息读取方法和 Lexical 固定依赖；SQL baseline 不变。图片限制为 PNG、JPEG、WebP、GIF，每次输入最多 10 张、每张 16 MiB，窗口待发送总量最多 128 张／64 MiB；普通路径引用最多 128 个。数量准入覆盖多选、粘贴、拖入和分批添加，不裁剪历史图片。Base64 约增加三分之一体积，Provider 更小的限额仍可能拒绝，不能把本地限制当远端资格。未发送附件只保留窗口内存，重载会丢失，成功受理的附件沿原历史保留。图片能力仍由实际 Provider 决定，本地 token 估算不能推造图片用量。

当前行为与限制由[桌面手册](../../../../docs/handbook/clients/desktop/README.md#提示词与附件)、[Native owner](../../../../apps/desktop/README.md#markdown-与附件输入)、[Agent owner](../../../../packages/agent/README.md#用户图片输入)和[跨包边界](../../../../docs/active/unified-agent-boundary.md)负责。2026-10-18 Windows x64／Bun 1.4.3 的真实 SQLite/Artifact、HTTP/Client、受控两种 Provider 映射与隔离 Chrome 测试覆盖当前实现；未运行真实付费视觉模型，不构成安装或跨平台资格。

2026-10-19 同平台的独立普通 Native 开发窗口补齐真实 `deepseek-v4-flash`／Chat Completions 混合附件资格：系统选择器分别选工作区外 INI 和直接图片，原文件工具成功读取、图片文字及红色方块数量识别正确；封存 Model 输入核原图字节、原正文与独立文件元数据，无 `context_source_unavailable` 或同目录未选说明。具体证据与后续浏览器性能、移除／切换回归归 Native owner；此结果不扩为其他提供商、Responses 真实端点或跨平台资格。
