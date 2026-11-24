# Agent Note: 办公预览迁移到沙箱 iframe

Status: implemented

## Problem

独立 WebContentsView 盖住宿主 DOM 的下拉层。工具栏为此曾给办公预览增加更高的透明视图。用户要求把办公正文迁到 iframe，让宿主直接处理下拉浮层和文档布局。

## Decision

Word、Excel、PPT、PDF 使用沙箱 iframe。Main 按当前 Root、直系子帧节点和单次随机地址限制 `kite-office-preview` 清单；关闭、替换或权限失效撤销该清单。iframe 使用不透明来源和禁脚本 CSP，批准的渲染器与选区控制器放在该帧单独的 JavaScript 世界。Electron 的 WebFrameMain 默认执行接口进入页面世界，Main 通过帧的 DevTools 会话创建专用世界，再在该世界执行固定渲染与交互代码。

## Alternatives considered

- 保留独立文件视图与更高的透明菜单视图。文件安全边界可复用，但办公浮层仍需跨原生视图编排。
- 让 iframe 与宿主同源、共用页面 JavaScript 世界。菜单布局直接可用，但文件内容将邻接宿主组件和授权桥，选区控制器也会暴露给页面世界。

## Consequences

正文、宿主菜单与缩放几何由同页布局。原预览授权、源摘要和选区核对继续由 Main 拥有，输入表单留在可信独立视图。此决定替代 [Excel](2026-11-16-xlsx-native-preview.md)、[Word／PPT](2026-11-16-word-ppt-native-preview.md)的独立文件视图，以及 [工具栏决定](../simplification/2026-11-24-native-file-preview-toolbar.md)中办公菜单的原生浮层。验证归 [Desktop owner](../../../../apps/desktop/README.md#预览工具栏与修改请求)。

子帧等待窗口可见后再初始化需要动画帧的渲染器。Chrome 调试连接释放时，Main 同时撤销文件清单和预览输入，宿主显示预览中断与重试。

宿主样式跨不过 iframe 边界。Main 生成的四种办公预览入口共用一份滚动条与界面主题样式，使用 Electron 的 `nativeTheme` 处理已打开预览的主题切换。页面颜色继续由文件及各格式渲染器处理，强制配色由系统处理。 [共享样式](../../../../apps/desktop/electron/isolated-preview-chrome.ts)

正文缩放经原帧隔离世界的格式控制器更改比例。实窗中 Chromium 将某些发生在不透明 iframe 上的捏合事件送给 Root，宿主经命中确认后向该帧单向转发有限的滚动增量；控制器核对发送方为直属父窗口。原生菜单只对聚焦在办公预览的缩放组合键让出处理，宿主工具栏使用已准入的预览状态回读同步。 [缩放输入](../../../../apps/desktop/electron/office-preview-zoom.ts)

发送选区请求后，会话恢复可用原 activation ID 重读当前会话。Main 只在新 activation、连接变更或原资源准入失效时退役预览。Windows 实窗曾出现同一会话重读后正文空白；IPC 回归核对重读时原帧仍可读取，实际切换后旧帧地址立即失效。 [Main IPC](../../../../apps/desktop/electron/native-ipc.ts) · [窗口回归](../../../../apps/desktop/test/isolated/office-preview-security.test.ts)
