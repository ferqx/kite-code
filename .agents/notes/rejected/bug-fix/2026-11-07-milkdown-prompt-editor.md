# Agent Note: Milkdown 提示词编辑与共享 Markdown 渲染

Status: rejected — 用户在交付前取消输入框Markdown渲染，原生纯文本输入已替代此方案。

本方案曾短期接入并局部验证，交付前已移除全部Milkdown代码与依赖；下文仅保留当时选择和代价，不能作为当前实现依据。当前采用[纯文本输入决定](../../implemented/bug-fix/2026-11-07-plain-prompt-markdown-messages.md)。

## Problem

用户要求输入、用户消息与Agent回复沿同一Markdown规则，表格正确渲染，发送及历史接管不抖动。手写源码坐标与DOM回滚方案虽通过机械回归，用户实测仍认为编辑体验不佳，并明确选择Milkdown及现有客户端样式。本决定替代[共享编辑决定](../../implemented/bug-fix/2026-11-07-shared-markdown-editor.md)中的手写编辑内核；该记录的稳定输入身份、有界SVG复用、图表固定阅读区域和操作准入理由继续适用。

## Proposal

采用锁定的Milkdown／Crepe7.23.0与ProseMirror管理输入事务、选区、输入法和撤销；保留Composer的Markdown字符串接口。编辑器直接消费共享GFM／CJK／数学AST，通过schema适配表格、引用、脚注和安全图片描述，不采用Crepe独有的Pandoc公式限制。普通LaTeX代码围栏与真正数学块分开，不能因一次其他编辑互相转换。公式沿共同KaTeX参数；图表、块级公式及提示标题通过React portal复用共享展示与读取生命周期。每条只读消息不创建编辑器。

不加载Crepe正文reset或另一套主题，只加载必要结构CSS；排版仍由`.typeset-chat`、共享颜色与字体变量及Native覆盖负责。源码未编辑时保留原文，整段粘贴保留输入源文；实际编辑允许标准化合法Markdown写法，不丢失语义。同步发布文档变更，避免立即发送丢掉最后一次编辑；同值父级回传不重设选区或历史。scope或外部文档接管通过ProseMirror清理旧格式与组合输入并重置历史；暂停的Activity只读并保留节点，真正移除时销毁。代码编辑内Enter换行，普通正文保留Enter发送／Shift+Enter换行。

共享只读renderer、投递与已保存正文的组件分支、原commandId展示身份及物理消息准入继续保持；独立同文输入不合并。Markdown图片不读取资源，HTML不执行，附件及文件打开仍由原业务接口管理。未改工具定义或协议版本，未增加普通dev／prod测试入口。

## Alternatives considered

- 继续扩充手写beforeinput／坐标映射：用户已实测否定体验，继续维护浏览器组合输入、原子光标及撤销不符合本次已确认方向。
- 将消息收窄到编辑器默认子集：再次违背GFM表格和三处一致的要求。
- 原样采用Crepe全部默认样式和语法：其正文行距、表头及公式规则与现有客户端不同；选用编辑内核和结构CSS，保留共同语义及样式。
- 每条用户消息挂只读Milkdown：增加活动编辑状态和资源，且仍不能统一Agent正文；只读renderer继续复用即可。

## Consequences

增加锁定编辑器依赖与打包许可收集，删除手写源码坐标、原生DOM回滚、独立撤销栈和F2源码弹窗。编辑控件的DOM可以不同于只读正文，Markdown解释及排版契约保持一致。第三方CodeMirror和表格节点的DOM由各自node view管理，不能误当用户输入重新解析；未改变公式的选中更新不重建KaTeX子树。验证、客户端范围和剩余资格沿[UI owner](../../../../packages/ui/README.md#markdown-提示词编辑)及[Desktop owner](../../../../apps/desktop/README.md#markdown-与附件输入)，产品行为沿[桌面手册](../../../../docs/handbook/clients/desktop/README.md#提示词与附件)。