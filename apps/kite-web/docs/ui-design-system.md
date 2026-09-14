# Kite Web UI Design System

状态：active

读取时机：修改Web全局样式、布局、主题、Sidebar、Timeline、状态反馈、可访问性或新增展示组件时。

验证：`bun run --cwd apps/kite-web typecheck`、`bun run --cwd apps/kite-web test`、
`bun run --cwd apps/kite-web build`，以及1280×800、1024×768、390×844的Light/Dark真实Browser检查。

## 共享会话页面

Web 与桌面共用 [kite-client-ui](../../../packages/kite-client-ui/README.md) 的主页面、侧栏、会话消息、控件和样式。暖中性色、间距、阅读宽度、消息折叠与窄屏目录在共享 owner 中维护，禁止在 Web 再写一套主页面或消息组件。新增或修改 Web 控件时必须先复用共享 shadcn 组件；缺少的通用控件先接入共享包，不在 Web app 内复制原生控件、Radix wrapper 或局部样式版本。允许专用组件的边界、上游差异检查和跨端验证要求以[共享基础控件规范](../../../packages/kite-client-ui/README.md#基础控件)为准。Web 保留页面内 dark/light 切换，默认 dark；相同组件与布局只切换共享颜色变量。

共享页面与控件样式限定在 `.kite-client` 根下，通用控件规则不覆盖诊断标签的 Tailwind 样式；Agent Markdown 使用两端相同的 shadcn/typeset stylesheet、`typeset-chat` preset 与 Geist 字体，避免 Web preflight 与原生浏览器默认值造成两端差异。共享 CSS 只保留选择、溢出、链接和文件操作规则，不建立第二套正文排版。桌面常用与最小窗口、Web 1280 × 800、1024 × 768、390 × 844 均按实际 React 组件检查。

Web 只读策略不注入新建、任务输入、审批、停止、配置和本地文件操作。目录点击或 Enter 直接加载消息，无标题搜索或二次确认；没有权限的操作不显示入口。窄屏目录使用同一个 Sidebar，展开时隔离背景焦点，Esc 关闭并返回开关。

[Tailwind 入口](../src/styles/globals.css)同时扫描共享控件源码，Button／Textarea 的 shadcn/ui 来源与适配由[共享 owner](../../../packages/kite-client-ui/README.md#基础控件)维护。

## Web 诊断与 API Docs

这两个现有专题继续由 Web owner 维护，使用 [globals.css](../src/styles/globals.css) 的语义变量与现有基础控件；不因主页面共享扩大 Browser 数据范围或操作权限。日志与上下文仍按需读取，API Docs 保留独立路由。

- **Session tabs**：History是默认阅读视图；Runtime logs是按需诊断视图。Tab必须使用`tablist/tab/tabpanel`语义并显示明确文字。
- **Log row**：收起态显示sequence、event type、category、status、时间和摘要；展开态把Category、Status与Detail type分成独立字段，
  `unknown`显示为`Not reported`，不把内部枚举拼成一条classification文本；同时提供人类可读解释与原始字段名，长字段在自身
  terminal surface内滚动，不把任意JSON直接倾倒到页面。
- **Model Context Inspector**：由prepared model invocation显式打开右侧modal Inspector；顶部始终标识`Local diagnostic`，内容分为Overview、
  System prompt、Messages、Tools与Request settings。Prompt、message part与tool schema使用可滚动terminal surface；任何truncation必须显示文字提示。
  Inspector支持Escape、backdrop与Close按钮关闭，关闭后不保留第二份context state。
- **Empty/Error**：一个图标、一个标题、一段说明、至多一个主要动作。

## 可访问性与验证边界

交互元素保留明确 role、可访问名称、焦点反馈与状态文字；选择态不只依靠颜色，长内容在自身区域滚动。主页面使用 HTML 预览优先流程，测试数据与真实服务证据分开报告。键盘、屏幕阅读器、文字放大与系统输入法各自验证，截图不构成完整无障碍或原生资格。
