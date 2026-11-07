# Agent Note: 纯文本提示词输入与统一 Markdown 消息

Status: implemented

## Problem

用户先要求输入、用户消息与Agent规则一致，实际发现表格缺失，随后否定手写编辑体验并选择Milkdown。继续验证后用户明确认为输入Markdown编辑过于复杂，改为输入框不渲染、消息支持Markdown。当前决定依这一最新要求替代输入层，不能继续用早期三处编辑预览要求恢复富文本控件；消息仍须保留完整Markdown并在发送、接管和重开期间稳定。

## Decision

PromptEditor使用原生Textarea编辑原始字符串，Composer继续以draft/onChange交接；输入不解析或序列化，不创建Markdown节点及源码弹窗。onInput同步通知宿主，未回传前保留本地输入，同值回传不重设选区。Enter发送、Shift+Enter换行，组合输入确认与229按键不发送；普通文本／HTML粘贴按原生纯文本处理，文件仍沿原附件入口。读取暂停和真正的业务禁用阻止编辑、发送及文件动作。用户进一步明确，发送按钮已有loading，不应仅因发送而禁用或只读输入；Composer现仅封锁重复提交，保留原生编辑、透明度和焦点。首发等待的新编辑即时写入原创建意图的目标Session草稿缓存，通过对象身份避免原受理回执消费新草稿；原Session完成可见接管后才清理准备页副本，回执丢失不恢复已被用户改写或清空的原文。

原生控件管理选区、输入法和撤销。真实Chromium探针显示，同值value赋值不会清理撤销，跨scope时因此在布局阶段先改变再恢复原文，不派发输入事件；普通切换保留DOM，不能撤销出旧会话内容。只有旧组合输入跨scope时替换控件，拒绝迟到候选。外部替换沿宿主值接管，不维护另一套源码映射、DOM回滚或编辑事务。SessionPage即使暂未启用首次准备屏障，也记录准确页面身份；同一首发正文的历史接管不再次隐藏history／footer或失焦，真实scope变化立即清理这一已显示证明，仍等待新页准备。该记忆使用ref，不给未启用屏障的页面切换增加第二次render。

用户消息和Agent回复都使用MessageContent的固定GFM／CJK／公式与扩展renderer，PromptMarkdown仅委托它；不将消息收窄到输入控件语法子集。保留[共享编辑阶段](2026-11-07-shared-markdown-editor.md)中已核commandId展示身份、同组件接管、复制控件固定尺寸、有界SVG及固定绘图区域的理由和限制。物理消息ID、业务回执、未知恢复、完整读取及文件打开准入不变，独立同文输入不合并。末尾元素不叠加外边距；Native末尾一级／二级标题移除分隔线及其留白，标题后有内容时保留原样。用户后续要求长消息默认收起：普通用户正文以约360px／矮窗口半屏限制展示，泡内渐隐与内阴影提供展开，再次收起不替换正文DOM；源文、附件、全文复制及失败／未知恢复提示不被截断。CSS从首帧限制高度，活动页的尺寸观察决定按钮，手动选择跨接管和缓存保持，冷重开默认收起；键盘进入隐藏操作时展开定位。

## Alternatives considered

- 继续手写Markdown可视化编辑：用户已实测否定，源码坐标、原子光标、DOM回滚和撤销复杂度已无必要。
- 继续[Milkdown方案](../../rejected/bug-fix/2026-11-07-milkdown-prompt-editor.md)：曾接入及局部验证，但用户在交付前取消输入预览；其依赖、schema／serializer和专用CSS随之移除，保留拒绝记录避免误以为仍需恢复。
- 同时保留纯文本／富文本切换：当前需求仅为普通输入，没有必要增加第二种文档状态和切换操作。
- 用户消息改用纯文本或有限子集：违背用户要求，也会丢失已支持的表格、公式及Agent展示能力；共同只读renderer继续复用。

## Consequences

输入与发送原文更直接，选择和撤销沿浏览器；输入区不再提供表格单元格、公式和代码专用编辑。Milkdown及旧Lexical专用依赖移除，消息安全限制、图表资源上限、流式及复制准入保持；没有工具或协议版本变化，也没有新增普通dev／prod测试入口。Native输入的13px字体和30px行高沿原内容主题。

产品预期沿[桌面手册](../../../../docs/handbook/clients/desktop/README.md#提示词与附件)，控件与样式沿[UI owner](../../../../packages/ui/README.md#markdown-提示词编辑)，执行过的回归、浏览器全过程、代码版本及未取得的Electron／Provider资格沿[Desktop owner](../../../../apps/desktop/README.md#markdown-与附件输入)。