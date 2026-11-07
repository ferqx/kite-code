# Agent Note: 提示词与消息共用 Markdown 编辑及展示

Status: implemented

## Problem

用户要求提示词输入、用户消息和Agent回复采用相同Markdown规则，发送、历史接管与重开不能抖动。原输入使用Lexical子集，表格未正确渲染；发送占位的纯文本及保存后的GFM又有不同尺寸。早一轮[提示词展示方案](2026-11-07-prompt-markdown-consistency.md)将只读用户消息收窄到Lexical子集，仍违背三处一致的明确需求；本决定替代其编辑器与排版选择，原输入身份与历史接管理由继续适用。不同物理消息ID还会触发气泡重建。

## Decision

输入框作为Markdown编辑器，以原始字符串为唯一编辑状态，直接复用MessageContent及其固定parser、GFM／公式／图表语义和CSS；PromptMarkdown仅委托MessageContent。现有HAST附加源码offset，浏览器beforeinput／target range与选区映回原字符串切片，未修改部分不经过serializer。IME允许浏览器临时DOM，结束后回滚该临时修改并只提交一次；普通绘制不收集临时DOM记录，原子内容内的异步绘图与复制反馈不参与原生输入回滚；代码、公式等原子内容通过源码编辑保留完整语法。共同管线在KaTeX替换子树之前保留公式源文边界；派生提示标题不作为可直接改写的正文。编辑态光标锚点仅提供有效的浏览器输入位置，不进入源文、剪贴板或只读消息；全选显式归当前提示词所有，避免丢掉隐藏语法或选中整页。撤销与编辑状态隔离于当前scope，迟到组合输入不能写入其他会话。

代码复制及文件路径节点保留布局，操作资格仅改变可用性，不插入新控件。Mermaid派生SVG按完整源码及主题色复用，最多16项／4MiB，窗口隐藏释放；只缓存纯图像及固有尺寸，不缓存DOM、宿主回调或操作资格。闭合图表按源码行数预留160–520px阅读区域，inline-size containment固定其固有宽度贡献；首次绘图、源码切换和错误回退不再撑动气泡，图像保持自然尺寸并在区域内滚动。未闭合围栏继续显示可编辑源码，完成语法时的主动编辑仍可改变文档结构。

Native投递占位与已保存inline正文使用同一组件分支；已核实的公开输入commandId作为展示别名，旧sourceIds仅经同Store／Session原Run核实后参与。物理消息ID、完整读取、复制证明、未知恢复和文件打开准入保持；独立同文输入不合并，继承记录不消费当前投递身份。HTML、图片、URL和图表安全限制继续沿共同renderer。

## Alternatives considered

- 将所有消息收窄为Lexical子集：早一轮已暴露表格缺失，且削弱Agent已有Markdown能力，与用户明确要求冲突。
- 为Lexical另补GFM、公式和图表节点及serializer：仍需维护两套语义和排版，源文往返会增加转义、脚注与格式丢失风险。
- 每条历史保留一个只读活动编辑器：无助于统一Agent renderer，还增加观察器和编辑状态；共同只读组件即可。
- 只改气泡key或CSS：能减少重挂载或个别字号差异，无法消除解析规则差异、复制按钮插入及冷重开图表固有尺寸变化。
- 将SVG持久缓存或挂入可交互DOM：引入额外敏感正文存储或执行面；本次仅使用有界内存image缓存和稳定阅读区域。

- 仅把DOM Range放在只读原子块之后：真实Chromium会把下一次输入重定位到文档开头；编辑态需要有效文本锚点，不能由最终截图或JSDOM选区代证。
- 在KaTeX生成节点上补源文坐标：原节点已被插件替换，需在共同管线先保留原位置再派生展示。

## Consequences

删除Lexical编辑运行依赖及专用排版。用户随后否定手写体验并尝试Milkdown，又明确取消输入框Markdown渲染；本记录的源码坐标、DOM回滚、独立撤销和F2机制已由[纯文本输入决定](2026-11-07-plain-prompt-markdown-messages.md)替代，[Milkdown方案](../../rejected/bug-fix/2026-11-07-milkdown-prompt-editor.md)仅保留取消理由，不能据此恢复编辑内核。共享只读renderer、稳定输入身份、准入与图表布局／有界图像复用理由仍适用。当前实现、输入法及过程验证沿[UI owner](../../../../packages/ui/README.md#markdown-提示词编辑)、[Desktop owner](../../../../apps/desktop/README.md#markdown-与附件输入)和[桌面手册](../../../../docs/handbook/clients/desktop/README.md#提示词与附件)核实；大单条首次解析与Mermaid计算成本仍存在，不承诺固定CPU时限。本决定补充原[扩展内容决定](../architecture/2026-10-22-desktop-markdown-content.md)，其安全、流式与生命周期限制继续适用。