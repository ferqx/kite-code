# Agent Note: Excel 原件预览和办公 Skill 独立

Status: implemented

## Problem

Excel 预览曾先转换成 HTML，再从生成内容定位单元格和公式。这使打开工作簿和装配通用 Shell 都依赖固定转换资产，无论用户使用何种工具生成文件。

## Decision

Excel 由 Desktop 的隔离预览读取原工作簿快照。ExcelJS 解析数据，SSF 展示数值格式，TanStack Virtual 提供虚拟网格。选区绑定源工作表和地址，以及现有文件版本。提交继续使用 [现有可信输入和原附件验证](2026-11-11-office-inline-request-isolation.md)。原工具栏 Skill 入口已由 [文件预览工具栏决定](../simplification/2026-11-24-native-file-preview-toolbar.md)收敛到会话的 Skill 选择。PDF 走既有 worker。后续 [Word 与 PPT 迁移](2026-11-16-word-ppt-native-preview.md)沿用同一预览和提交边界。

## Alternatives considered

- 继续从转换后的 HTML 建立 Excel 选区。此方案复用旧实现，但打开文件和读取选区仍需要固定转换资产，也会连带影响通用 Shell 装配。
- 将预览 PDF 随 Agent 产物交付。可以复用 PDF Viewer，但工作表切换、公式和可准确定位的 Excel 单元格选择需要独立接口，也会给对话增加一个文件。

## Consequences

后续 [办公预览 iframe 决定](2026-11-24-office-preview-iframe.md)替代了独立文档视图与 session 的呈现方式。原件读取、选区证据和可信请求输入的边界继续适用。

已附原件、权限、修改输入和新版交付仍由 Kite 现有 owner 管理。ExcelJS 读取公式及已存值，公式结果随源文件缓存。真实 Windows 独立 Excel 链路和四个 Skill 的验证范围归 [Desktop owner](../../../../apps/desktop/README.md#办公输出文件)。
