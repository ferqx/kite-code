# Agent Note: 提示词发送前后的 Markdown 一致性

Status: implemented

## Problem

用户要求提示词输入与用户消息的Markdown必须一致，发送后不能抖动。原发送占位使用纯文本，保存后交给另一套GFM／扩展renderer；字号、标题、代码、空行和异步图表均可能改变展示。占位与持久记录使用不同物理ID，React还会重建气泡和选区。

## Decision

早一轮以输入框的Lexical节点、固定TRANSFORMERS、保留换行选项和DOM主题作为用户提示词的共同来源。只读正文同步生成该renderer的静态DOM，发布前完成排版，随后释放临时editor；不为历史消息保留活动编辑器。相同正文的回调和准入更新不替换DOM。相对链接保留原路径供宿主核验，HTML／图片不取得执行或远程读取能力。

2026-11-07用户进一步明确输入、用户消息与Agent回复必须采用同一规则，并实际发现表格未渲染；上述Lexical展示选择已由[共享Markdown编辑器](2026-11-07-shared-markdown-editor.md)替代。以下身份决定及避免历史活动编辑器的理由继续适用；旧展示后果不再作为当前产品范围。

Native投递占位和已保存inline正文使用同一组件分支；已核实的公开输入commandId作为展示别名，旧sourceIds仅经同Store／Session的原Run核实后参与。原物理消息ID、复制证明、未知结果和当前文件打开准入保持。独立同文输入不合并，继承记录不消费当前投递身份。

## Alternatives considered

- 只给占位改用MessageContent并对齐CSS：输入仍有另一个解析器，图表、公式、空行与代码会在保存后改变展示。后续方案同时替换编辑器以解决这一点。
- 全面替换编辑器或为Lexical补齐另一套GFM编辑节点：早一轮因编辑、序列化和输入法范围没有采用；用户明确三处一致后，完整替换已成为必要工作，另补第二套语义仍未采用。
- 每条历史保留一个只读Lexical编辑器：长期保留状态、观察与事件；历史只需要共同只读展示，此理由继续适用。
- 只调整气泡key：减少重挂载，不能消除纯文本到不同Markdown排版的高度变化；身份与共同renderer必须同时处理。

## Consequences

输入身份与稳定展示key只用于DOM关联，不替代真实消息、读取或操作资格。早一轮限制用户消息扩展以匹配Lexical输入的后果已失效，当前输入仅编辑原文、用户与Agent共用完整Markdown的规则以[最新决定](2026-11-07-plain-prompt-markdown-messages.md)及[UI owner](../../../../packages/ui/README.md#markdown-提示词编辑)为准；输入接管及浏览器证据沿[Desktop owner](../../../../apps/desktop/README.md#markdown-与附件输入)，产品预期沿[桌面手册](../../../../docs/handbook/clients/desktop/README.md#提示词与附件)。原[扩展内容决定](../architecture/2026-10-22-desktop-markdown-content.md)的安全理由继续适用。
