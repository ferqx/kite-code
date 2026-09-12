# 变更阅读与外部编辑器

[共享文件变更面板](../../../packages/kite-client-ui/src/FileChanges.tsx)使用 Service 持久投影：成功文件工具的 `tool.file_changed` 记录提供路径，按同一 toolId 与 `tool.finished.result` 配对。文件工具的 stdout 已由真实 preimage 和提交内容生成差异或写入内容，桌面不再从工具参数拼造 diff，也不读取 Store。

面板展示会话中的每次文件操作，不能解释为当前工作区 Git diff 或 Agent 的完整累计贡献。用户原有修改不被归入 Agent；Shell、MCP 等没有逐文件事实的修改不自动补入列表。历史缺少路径或终态输出时明确显示不可用。输出本身有上限，面板明确说明可能截断；二进制及未被文件工具报告的内容没有完整覆盖承诺。普通工具过程同时保留 stdout 与 stderr。

面板从会话顶栏“文件变更”打开，默认收起；所有窗口宽度都在阅读区右上方以 360 px 内的副层覆盖展示并独立滚动，不改变消息列或底部输入区的宽度和位置。每次文件操作可展开阅读真实差异，关闭或 Esc 返回按钮焦点；切换会话关闭副层。编辑器在设置的模型与 Provider 分类中选择，由 [App](../src/App.tsx)在当前进程共享，默认 VS Code，同时作用于所有路径入口。关闭副层不改变会话、运行或草稿，路径仍使用以下 native 校验。

[原生打开接口](../electron/editor.ts)只接受固定的 VS Code、Zed、TextEdit 枚举。[Electron host](../electron/host.ts)先绑定当前 connection generation，再核实文件存在、项目根未漂移、目标为项目内普通文件；拒绝上级目录、控制字符、外部绝对路径和逃逸 symlink。macOS 使用固定 `/usr/bin/open` 与独立 argv，不开放任意 shell、executable、环境变量或文件读取接口。此动作打开的是磁盘当前内容，无法复原某次历史修改时的文件。

路径展示不授予打开权限，检查在 Electron 主进程重新执行；其他平台返回尚未验证的限制。原生窗口和实际编辑器启动资格应独立于路径单元测试记录。

验证：[投影配对测试](../test/presentation.test.ts)、[真实服务开发闭环测试](../test/development.test.ts)和 [Electron 本机操作测试](../test/host-native-operations.test.ts)。开发闭环测试使用隔离目录与本机模型 fixture，执行真实文件写入及 Bun 测试，校验用户已有文件不变，并重启服务继续同一会话；host 测试覆盖路径、普通文件和 symlink 逃逸边界。它们不替代真实 Provider、preload 或编辑器窗口证据。

迁移前 Tauri 版本的本机 macOS 验收曾确认 VS Code 打开对应测试文件；TextEdit 仅验证启动分发，Zed 未安装。详细范围见[原生验收](native-validation.md)。Electron 版本仍需重新验证真实 IPC 与编辑器窗口，不将历史结果或路径测试视作当前平台资格。
