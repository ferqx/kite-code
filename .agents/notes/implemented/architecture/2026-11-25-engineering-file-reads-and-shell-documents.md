# Agent Note: Engineering file reads and managed document processing

Status: implemented

## Problem

`read_file` 曾同时生成工程文件编辑基线和 PDF 页图。默认读取 PDF 就会生成像素，并让工具结果把页图送入模型。CSV 等格式处理也需要按任务选择列、聚合或提取片段。已上传文件已有按授权准备的工作区副本，Shell 可以在当前权限下消费该路径。

## Decision

`read_file` 按文件名识别源码、脚本、配置和工程说明，沿原文件引擎校验 UTF-8 并返回行窗口和基线。范围外的格式通过 `unsupported_file_type` 给出处理路径。受保护目标、会话附件绑定以及真实读写权限由原层核验。 [文件工具](../../../../packages/agent/src/tools/files/README.md)

CSV 与 Office 等格式通过受管 Shell 选择相应解析器。PDF 文本与页图经同一个随包助手，复用固定的 PDF Worker。页图返回已保存的 PNG 路径，选中的图像经后续 `view_images` 交给模型。桌面分页预览继续使用自己的原文件和显示流程。 [文档助手](../../../../packages/agent/src/tools/documents/README.md)

## Alternatives considered

- 在 `read_file` 中继续提供多媒体并默认返回正文。需要把文件基线、正文提取和视觉读取长期留在同一工具，且普通 PDF 读取仍可走像素路径。
- 将源码读取一起移到 Shell。这样会失去现有的分页、版本基线和无进程读取链路。对编辑、项目说明与配置保留原文件工具。
- 由普通读文件内部自动启动 Shell。显式调用可以使用原 Shell 作用域，选择具体页与格式，用户也能观察实际运行和取消。

## Consequences

Shell 的文档处理获得独立可观察的 Job，文档页图由显式查看选择。保存的历史工具结果按既有引用读取。 [Windows 执行回归](../../../../apps/service/test/isolated/session-execution-root.test.ts)

同一份单页 PDF 使用 Windows 本机固定 Provider 各回放三次。两条路径均提取到相同正文，后续模型请求体从 33,424 字节降到 19,516 字节，页图从一张降到零张。受管 Shell 每次新增一个 Job，并均确认进程树退出。运行中进程树工作集采样峰值的中位数从 318.7 MiB 升到 504.6 MiB，本机整轮耗时中位数从 1.69 秒升到 2.82 秒。该样本覆盖本机请求与进程开销，真实模型首字延迟和桌面渲染性能仍需独立测量。
