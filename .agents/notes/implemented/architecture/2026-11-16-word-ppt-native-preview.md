# Agent Note: Word 和 PPT 原件预览及选区修改

Status: implemented

## Problem

Word 和 PPT 的 Desktop 预览曾先转换成 HTML。用户选择其他 Skill 生成或修改文件时，打开原件和定位批注仍倚赖随包转换资产。

## Decision

沿用 [Excel 原件预览](2026-11-16-xlsx-native-preview.md)的独立 View 和只读清单。Word 用 `docx-preview` 渲染，按源 XML 结构将段落绑定到渲染节点。稳定的预览页支持正文范围提交。PPT 用 `@aiden0z/pptx-renderer` 渲染，采用演示关系顺序与原部件的对象 ID 描述选区。两者沿用 [可信请求输入](2026-11-11-office-inline-request-isolation.md)。原工具栏 Skill 入口已由 [文件预览工具栏决定](../simplification/2026-11-24-native-file-preview-toolbar.md)收敛到会话的 Skill 选择。

## Alternatives considered

- 保留转换主路径，在资产缺失时使用独立应急视图。这样同一原件的选区语义会随环境变化，完整体验仍与转换资产绑定。
- 只预览转换后的 PDF。PDF Viewer 能复用分页和文字选择，但无法从图层直接恢复 PPT 对象与源部件，也无法准确描述跨格式的 Word 段落路径。

## Consequences

后续 [办公预览 iframe 决定](2026-11-24-office-preview-iframe.md)替代了独立文档视图与 session 的呈现方式。原件读取、选区证据和可信请求输入的边界继续适用。

Desktop 直接打开原件。Word 使用原件中的分节和分页信息，PPT 展示原幻灯片，演讲者备注保留在原文件中。渲染器及其源节点适配需在升级时一起验证。Windows 真实文件的过程与现有打包边界见 [Desktop owner](../../../../apps/desktop/README.md#办公输出文件)。
