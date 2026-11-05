# Agent Note: Skills 正文预览与执行加载分开

Status: implemented

## Problem

用户要求 Skills 详情以名称、简介和可阅读正文为主体。现有全局目录只提供元数据；内置技能在缺少运行依赖时仍已安装，界面却把缺省来源显示为无法确定，并直接暴露能力ID。展示正文不能为读取说明而创建任务、获得执行依赖或接收任意文件路径。

## Decision

保留完整元数据目录，另由 Service 的同源用户知识 owner 提供明确选择、准确版本和目录revision绑定的只读正文端点。Main用独立的generation／Store／read ID控制取消，Client与Renderer核闭合身份和1MiB UTF-8预算；人的预览不返回资源或进入模型。模型的 `load/readResource` 保留原依赖门禁。原目录决定的只读、完整分页和独立授权理由继续适用，见[原目录决定](../architecture/2026-10-07-native-readonly-skill-catalogue.md)。

## Alternatives considered

- 重用模型技能加载：缺依赖时不能阅读说明，还会将人的查看行为与Run能力选择混合。
- 将全文加入目录：分页必须传输所有技能正文，扩大元数据读取的成本与暴露范围。
- Renderer或Main根据名称猜文件路径：脱离Service实际配置、可信根及已发现版本，无法准确处理来源和换版。
- 独立预览：增加有限端点和取消租约，保留目录与执行加载的原职责，因此采用。

## Consequences

打开详情才读当前技能正文，切换、关闭及身份变化撤销所属读取；换版要求刷新，失败可显式刷新后恢复。已禁用或元数据无法核实的来源不因此读取文件。全局目录的能力快照不能判定实际Run能力，界面不展示工具依赖信息，保留禁用、配置及读取异常，不把 `skill_capability_missing` 呈现为技能不可用；实际模型加载门禁不变。没有新增启停、卸载、试用、工具定义或协议版本升级。当前合同与证据分别归[Service owner](../../../../apps/service/README.md#同源-skill-知识目录)和[Desktop owner](../../../../apps/desktop/README.md#native-skills-只读目录)。
