# Agent Note: OfficeCLI 办公技能

Status: implemented

运行时来源、安装段、随包范围和目录命名由[随包 OfficeCLI 运行时](2026-11-18-bundled-officecli-runtime.md)部分替代。三种基础格式的上游来源、许可和技能身份的取舍继续适用。

## Problem

内置 Word、Excel 和 PPT 指导引用了多种当前 Shell 可能缺少的解释器、库和校验工具。在 Windows 的一次 PPT 生成中，缺包、npm 缓存写入和脚本模块格式分别导致重试。用户选择改用 OfficeCLI 提供的技能，并沿用由宿主环境提供执行工具的边界。

## Decision

随包固定 OfficeCLI `main` 提交 `5fbf766` 的 11 个技能及其许可和参考资源。上游目录结构和文件原字节一同进入制品，知识接口直接返回上游正文。保留三种基础格式的 Kite 显示名和配置 ID，以延续已有的 Skill 选择。专项技能使用独立 ID，PDF 继续使用 [原内置来源](2026-11-16-office-skills.md)。

使用当前受管 Shell 中可解析的 `officecli`。Kite 的输出、授权和资源路径由宿主提供。预览与选区请求沿现有 Desktop 实现。

## Alternatives considered

- 继续随包提供旧的三种技能并补齐各套运行时依赖。该方案要求分别维护 npm、Python 和渲染校验工具，用户选择统一采用 OfficeCLI。
- 在制品内附送 OfficeCLI 可执行文件。该方案可提供开箱执行，需要单独维护各平台运行时的来源、升级和制品验证。现有工具来源由用户环境管理，任务范围是替换技能知识和资源。
- 改写上游安装段和 Word 示例以配合 Kite。用户要求原样导入，随包文件和正文以固定的上游版本为准。

## Consequences

安装可执行文件并让 Kite Shell 解析到它后，基础与专项技能通过既有能力和权限使用同一 CLI。用户同名项保持独立身份。构建核对全部随包资源摘要，正文加载和版本读取沿已有接口，Morph 二进制模板经受管 Shell 使用。 [Office owner](../../../../packages/agent/src/tools/documents/README.md)
