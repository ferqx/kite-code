# Agent Note: 默认 Service 与 Agent 主链去除重复规则

Status: implemented

## Problem

权限模块迁入 Agent 后，默认 Run 和只读 Skill 目录仍各自维护工具版本查找；权限装配与 Workflow 对同一组内建定义重复分类。内建注册集合在多个投影中重复列举，Runtime 已统一包装 admission，方法首行又检查同一个 closing 状态。这些重复位置使职责容易漂移，移动文件本身不能消除维护成本。

## Decision

Service 只提供真实注册、选择和可信宿主事实。默认配置共用内建注册集合及具名版本校验，保留各调用分支原优先级和生命周期。Agent `builtinCapability` 统一 Tool、Job、Action 固定分类，`workflowCapabilityDescription` 负责原 Workflow 投影；Shell 工厂复用同一 owner 的分类。公开 HTTP、权限模式、审批、范围及持久格式不变。

Runtime 的既有 `accountEntry` 作为公共 admission 首次同步封门位置，只删除十个方法体内同错误、同时间的重复首行检查。异步等待后、clone/freeze 后、私有回调及 control/observation 的检查均保留。

## Alternatives considered

- 把全部默认配置搬进 Agent：宿主身份、当前持久读取和 transport 装配仍有独立职责，整文件移动不消除重复，也会迫使 Agent 承接 Service 接口。
- 合并成通用注册框架或共享可变能力缓存：增加第二套 authority 与失效状态。本次只共享已经存在的固定定义和纯投影。
- 删除所有相似复查、序列化或资源：来源编译前后复查包住真实文件读取；文件消费证明不同于当前上下文；canonical 非有限数字与 Workflow 数字键顺序存在不同合同。外部 File descriptors 下的早期 native owner 虽无文件操作消费者，构造仍在 Provider 前核根路径和打开权限，提前关闭也改变真实关闭失败时刻。这些机制保留。

## Consequences

固定能力规则、Workflow 审批投影和首次 admission 分别只有一个负责位置；Service 的版本校验和内建注册表述不再双份维护。Workflow Job 仍三维 unknown/user，未知 Files 仍保原保守 write 投影，不能反向放宽执行权限。同名外部扩展不取得内建 read 资格。

本轮核对八个 workspace 的入口和依赖、Service 默认业务装配及 Agent Runtime/Loop/Execution/ExtensionHost/Store 主链；没有逐行重写所有 SQLite、平台、OAuth、UI 与维护叶子。各 authority 的并发、恢复与未知结果记录仍保留。本轮验收和未闭合门禁归[进度证据](../../../../docs/plans/unified-agent-refactor-v1-progress.md)；原[权限独立模块决定](../architecture/2026-10-11-agent-permissions-module.md)继续适用。
