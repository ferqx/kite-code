# Agent Note: 随包 OfficeCLI 运行时

Status: implemented

## Problem

原内置 OfficeCLI 技能依赖用户 PATH。Windows 实测中，两个 Shell 能继承有效的 PATH。缺少目录时模型先探测，再找已安装的程序或提出安装。用户选择在各平台制品中直接携带 OfficeCLI，并从文档操作开始。

本决定部分替代[原 OfficeCLI 技能决定](2026-11-16-officecli-skills.md)中的宿主安装、上游 Setup 保留及完整的随包技能目录。保留三种基础格式的上游来源、许可和 Skill 身份。

## Decision

随包固定上次实测的上游 OfficeCLI 1.0.161。Agent build 按原生目标选择官方资产，核对大小和 SHA-256 后放入既有 `platform/process/tools`。Terminal 和 Native 继续复用该 Agent 树。包内清单保留实际摘要与上游摘要，macOS 在既有签名过程中刷新实际摘要。

Service 校验包内程序并沿既有 Shell 工具目录提供 PATH。Office 操作通过普通 Shell Job 和文件交付。随包的 `docx`、`pptx` 和 `xlsx` 与 `pdf` 同级，使用各自的基础配置 ID。技能指引优先从工作区文件读取和落盘，常规 OfficeCLI 修改采用单进程批处理，以适应每次 Shell 调用独立的进程生命周期。技能标注 Kite 的改动，上游许可证、署名和第三方声明一同随包。用户安装的技能沿独立来源读取。

## Alternatives considered

- 由用户自行设置 PATH 并使用候选查找。此方案继续适用于外部工具，内置办公场景仍多一次环境探测。
- 在一次制品中同时携带所有平台程序，或安装后选择下载。采用构建时选择可使每个包只携带实际目标，并固定交付字节。

## Consequences

每个制品增加对应平台的一份自包含 OfficeCLI。升级时同步核对上游资产摘要、许可及技能内容。首次构建需要下载目标资产的网络或等摘要的本地构建缓存。

## Verification

[包外空 PATH 回归](../../../../packages/agent/test/isolated/jobs/ripgrep-package.test.ts)核本机实际程序、目标选择和许可。[内置技能回归](../../../../packages/agent/test/isolated/tools/documents/office.test.ts)核加载后的原身份和实际正文。制品签名、实时模型和平台资格由 [发行 owner](../../../../docs/active/release-control.md) 和 [办公资源 owner](../../../../packages/agent/src/tools/documents/README.md) 记录。
