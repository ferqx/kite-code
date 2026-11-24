# Agent Note: 桌面文件预览工具栏与选区修改

Status: implemented

## Problem

办公预览工具栏的「更多」以省略号遮盖系统下拉框。修改按钮重复了文档内的选区入口。文件工具栏维护了自己的按钮和表单外观。

## Decision

移除办公预览顶栏的「更多」和修改按钮，从文档内现有入口发起修改，使用原会话的 Skill 选择。交付文件的缩放、文件操作及 Excel 公式栏使用共享 shadcn 控件。缩放采用 shadcn Select。原生图片视图的菜单继续由透明原生浮层绘制。办公文件现已迁到 [沙箱 iframe](../architecture/2026-11-24-office-preview-iframe.md)，菜单由宿主 DOM 绘制。[Desktop owner](../../../../apps/desktop/README.md#预览工具栏与修改请求)

## Alternatives considered

- 将 Select 的 Portal 挂在宿主页面。宿主 WebContents 位于独立文件视图之后，菜单会被盖住。
- 给菜单预留布局空间。开合会移动预览正文，与用户要求的浮层交互冲突。
- 将办公预览迁到 iframe。首轮工具栏交付沿用独立文件视图，之后按用户确认的架构调整迁移。详见 [办公预览 iframe](../architecture/2026-11-24-office-preview-iframe.md)。

## Consequences

选区、准确文件版本和原修改请求的授权继续沿用原边界。普通交付文件仍通过「继续修改」附加整份文件。Office 原件呈现与选区实现见 [Excel](../architecture/2026-11-16-xlsx-native-preview.md)及 [Word 和 PPT](../architecture/2026-11-16-word-ppt-native-preview.md)。
