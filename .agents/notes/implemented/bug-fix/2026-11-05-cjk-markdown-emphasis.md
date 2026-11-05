# Agent Note: 桌面中文强调由解析器扩展保持原文

Status: implemented

## Problem

2026-11-05，用户截图中的`**下周如何调整：**如果…`原文星号成对，但桌面直接显示标记。只读原消息与新增回归确认：CommonMark的强调边界将结束前的中文标点和结束后紧邻的中文正文判为不能闭合，其他两处数字强调仍正常。修复必须同时覆盖renderer、缓存与Native Worker，不能改写消息、复制原文或流式绘制依赖的源码位置。

## Decision

桌面正文与纯语法入口同时使用固定`remark-cjk-friendly@2.3.4`的`parseOnly`扩展；沿原Markdown parser生成准确AST，不插入空格、零宽字符或重建文字节点。原始模型输出、HTML／图片／URL策略、复制资格及协议保持。插件在UI manifest与Desktop内联依赖清单中明确登记，构建保存原许可。

当前行为归[UI owner](../../../../packages/ui/README.md#markdown-消息内容)和[桌面手册](../../../../docs/handbook/clients/desktop/README.md)。规范依据为[CommonMark强调边界](https://spec.commonmark.org/0.31.2/#emphasis-and-strong-emphasis)与[扩展作者说明](https://github.com/tats-u/markdown-cjk-friendly/tree/main/packages/remark-cjk-friendly)。

## Alternatives considered

- 在原字符串中替换星号、加空格或插零宽字符：会改变原正文、复制及源码offset，也容易误处理代码与转义；不采用。
- 在已解析文本节点上补配对：要另行处理嵌套强调、链接、转义和跨节点边界，成为第二套行内解析；不采用。
- 复用既有remark生态的纯解析扩展：原位保留语法位置，同时覆盖主线程与Worker，维护成本较低；采用。只导入parseOnly，不在展示链中引入反向序列化。

## Consequences

中文标点旁的粗体／斜体可按CJK兼容规则显示；代码、转义与普通英文标点边界保持测试范围内的原行为。新增依赖及锁定闭包，插件发布依赖使共享`mdast-util-to-markdown`满足其较新范围，原编辑器回归同步通过。此改动只授桌面正文显示，不扩大独立Web／TUI语法范围、执行权限或发行资格。

截图原文及反例在旧实现实际失败；修后正文／缓存／流式／Worker／编辑器六文件37项1551断言通过，UI／Desktop类型和真实UI打包通过。原源码位置与prepared树不变，独立Worker无DOM／Node；完整Native安装包未重建。实际浏览器流式与历史过程证据归UI owner。
