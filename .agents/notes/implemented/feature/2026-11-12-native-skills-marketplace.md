# Agent Note: Native Skills.sh 搜索与用户目录安装

Status: implemented

## Problem

桌面 Skills 设置只读取已有技能。用户要先离开客户端寻找来源，再把文件放到本机并补齐 Kite 的配置，才能在设置中看到技能。桌面需要连贯的搜索、安装与发现流程。

## Decision

搜索和安装由 Native Main 处理，查询发送到固定 Skills.sh 目录。用户选择公开 GitHub 仓库中的单个结果，Main 校验文件并写入 `~/.kite-code/skills`。发布入口文件前完整准备配套文件，独占预留目录保护已有同名数据。

卸载从用户安装项详情明确确认。Main 核对目录与已读正文版本，将整项移入系统废纸篓或回收站。此前安装的用户目录条目沿相同规则卸载，内置技能与显式配置保留各自来源边界。

Service 将这个专用目录的技能纳入现有用户目录、可信项目目录及任务装配。显式配置继续按原可信根解析。安装项在任务绑定中记录原目录标识和正文版本，继承与恢复沿原任务选择。安装只发布本地知识文件。现有模型工具、资源读取和任务权限继续控制实际使用。

本决定扩展[用户级设置](../architecture/2026-10-24-user-global-extension-settings.md)与[只读目录](../architecture/2026-10-07-native-readonly-skill-catalogue.md)的发现范围。目录和正文的公开读取契约仍由这两项决定及[正文预览](2026-11-04-native-skill-document-preview.md)描述。实现和验证见 [Desktop](../../../../apps/desktop/README.md#skillssh-搜索与用户安装)和 [Service](../../../../apps/service/README.md#同源-skill-知识目录)。

## Alternatives considered

- 调用上游 `skills` CLI。它能处理更多源，但会引入外部命令与运行依赖，且其通用安装位置和联接行为超出 Kite 的专用用户目录。
- 安装后编辑用户 JSONC。用户配置仍适合显式管理自定义来源，专用安装目录可直接完成发现，避免文件安装和配置编辑成为两个需要一起恢复的写入。
- 递归永久删除安装目录。系统废纸篓可以保留正文和配套文件供用户恢复，移动失败时由界面反馈。

## Consequences

可安装条目取决于 Skills.sh 公共搜索与快照供应。专用用户目录支持冷开重新发现，不需要额外存储安装清单。安装期间以完整入口文件区分待发布目录和已可发现的技能，强制退出留下的未知占位保留并在重试时显示冲突。
