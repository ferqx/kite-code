# Agent Note: Office 内置 Skills

Status: implemented

## Problem

Kite 已能直接预览办公原件并提交选区。用户希望四种格式都能直接选用相应的内置 Skill，同时继续使用自行安装的工具和 Skill。

## Decision

把四个 Skill 的固定版本和声明资源放入 `office`，各格式保留自己的名称并使用 `office.<格式>` 作为配置 ID。用户同名 Skill 保留独立身份。模型按需读取知识，现有受管 Shell 可读取打包资源并使用任务允许的工具。预览、原件版本核对、选区和提交仍沿用 [Word 和 PPT 原件预览](2026-11-16-word-ppt-native-preview.md)及 [Excel 原件预览](2026-11-16-xlsx-native-preview.md)的宿主实现。

## Alternatives considered

- 要求每位用户从市场分别安装四个 Skill。该路径保留全部选择，但新环境打开文件后仍需要先安装对应知识，批注链无法直接使用随应用提供的默认项。
- 使用单一内置 Skill 配套固定编辑工具。这样会把普通修改请求绑定到同一套工具，并使构建依赖该工具的分发与平台支持。

## Consequences

四个 Skill 的正文、脚本、模板和许可进入构建库存，更新时需要一起审查来源版本、字节和资源引用。脚本运行服从当前 Shell 的依赖和权限。用户自行安装的 Skill 和工具沿相同通用入口使用。 [Office owner](../../../../packages/agent/src/tools/documents/README.md#内置-office-skills)

标准制品使用独立的 PDF helper、中文字体和 Office Skill 资源。编辑工具由用户选择的 Skill 和 Shell 提供。 [固定资产与执行边界](../../../../packages/agent/src/tools/documents/README.md#固定资产与执行边界)

已保留的旧 PPT 副本由 Desktop 核专属索引与文件摘要，再从确切版本渲染。页数和备注等索引字段保留原格式，供旧草稿恢复和页码定位。 [私有产物边界](../../../../docs/active/private-artifact-storage.md#当前办公交付与编辑边界)
