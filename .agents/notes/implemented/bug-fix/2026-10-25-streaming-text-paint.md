# Agent Note: 流式文字保留连续排版并在绘制层渐显

Status: implemented

## Problem

用户观察到普通回复也会在文本渲染时换行抖动。信息行28px高度修正只覆盖固定正文切换，未覆盖逐字span与最终连续文本的字距差异。Chrome155的隔离页面中，中英混排244px及英文558px宽度分别复现流式正文多出一行；仅修改状态行不能修复。

真实GPT复验后，用户再次指出首批文字时整块上下跳动。回看保留帧确认普通`autoRead`把`body.complete=false`的活动流式前缀显示成“回复未完成”，提示在后续封存时消失；同一用户消息锚点曾反向回落50px。先前仅核末尾18帧正文像素相同，漏掉首批文字的中间状态，不能据此确认整轮稳定。

## Decision

保留[增量Markdown决定](../architecture/2026-10-24-desktop-incremental-markdown.md)的整文语义、元素memo、读取准入和逐字节奏，仅替代逐字DOM／opacity实现。每个普通文字节点采用一个连续Text节点，layout effect以appendData同步追加，保持已有Range与用户选区。以CSS Custom Highlight的字素Range绘制颜色透明度，使用每个文字节点的一个注册数值属性及原生动画时钟；后续批次接续绝对时间，不回退旧字。字素各240ms、通常18ms错开、整批最多420ms。结束、减少动态效果、隐藏或卸载清理所属Range、样式与监听；不支持相关接口时直接显示内容。

共享`ModelOutputMessage`的普通自动读取仅在当前身份已核实的snapshot确为终态且输出不完整时显示“回复未完成”；读取尚在途及planned／dispatching／running不据未封存前缀生成终态提示。失败、取消、结果未知及已终止的不完整输出仍明确保留，专用显式reader原标签保持。此修正同时适用于Native与Web，不改原读取、取消、身份验证或复制资格；固定正文首段挂载另逐帧核对，未复现默认展开导致位移，因此未修改折叠实现。

[Custom Highlight规范](https://www.w3.org/TR/css-highlight-api-1/)与[高亮继承规范](https://www.w3.org/TR/css-pseudo-4/#highlight-cascade)限定绘制层属性并从来源元素继承自定义属性。实际颜色需取来源元素计算值，不能在全局highlight规则里用currentColor反复混合，否则祖先高亮的透明结果会继续继承，造成直到结束才整批显示。浏览器实测同时检查渐变颜色、几何位置与清理，不能只检查动画时钟存在。

## Alternatives considered

- 继续逐字span并只统一状态行：已修正信息行自身的16px后续位移，但文本排版仍可多出一行。
- 给逐字节点display:contents：同样宽度下仍复现原换行差异，未采用。
- 对流式和静态正文统一禁用font-kerning：实测可消除当前样例差异，但会改变正常正文排版；采用不改变字体与字距的绘制方式。
- 每批整段opacity渐显：仍会切分文字排版，且与用户要求逐字平滑出现不符。
- React逐帧打字：增加重渲染与积压，未采用；本次仍由浏览器驱动时钟。

## Consequences

普通文字不再随字数积累DOM包装，样式和Highlight数量只覆盖尚未完成的短时动画。绘制层能力不足时渐显降级为直接显示，但完整正文、布局、权限和复制语义不降级。`appendData`的命令式范围只限固定span中的一个Text节点，不允许其他来源写入或改变Markdown结构；格式空白不能被包进table／list容器。

范围包含共享桌面正文渐显，以及Native／Web共用自动正文读取的未完成提示，不改变Service消息、模型调用、工具、定时任务或会话持久化。验证与环境归[UI owner](../../../../packages/ui/README.md#markdown-消息内容)及[Desktop owner](../../../../apps/desktop/README.md#会话消息渲染验证)，不由本记录推导安装版或其他平台资格。
