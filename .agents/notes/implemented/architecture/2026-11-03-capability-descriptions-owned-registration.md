# Agent Note: 能力动态描述绑定实际注册归属

Status: implemented

## Problem

Service 已按 kind、定义和版本登记能力，但命中后仍将同一请求广播给 Shell、Files 和 Task，再按展开顺序合并动态事实。合法同名 Model 因此曾进入 Shell 输入校验；局部增加身份判断能修复该例，却仍依赖所有非所属模块正确返回未匹配。普通权限和 Planning 的重复拼接也容易漂移，使事实来源与审批规则的职责混在一起。

## Decision

在每个 Run 原有 `actual` 注册项中同时保存基础描述和可选的所属描述器。注册时按真实扩展对象绑定 Shell、Files、Task；请求只按完整注册身份选择该项，不从请求名称反推模块。普通权限、Planning 与只读 Shell 包装共用同一描述入口，不引入第二套注册表、公共接口或缓存。

这些注册与策略组合由 Service 的[权限装配](../../../../apps/service/src/permission-configuration.ts)集中负责，包含 global、model-only、每 Run 权限及同一闭包内的 Planning 初始化。根装配保留配置解析、真实资源、快照和唯一 Runtime 绑定，通过原对象及按需来源读取端口交接；自定义回调捕获、动态 authority 读取和每轮状态不因文件拆分改变。该边界让权限职责可独立阅读，不新增策略框架或另一份注册状态。

Model 直接返回静态描述；动态事实不得改变注册的 kind、定义或版本，冲突按 `capability_metadata_invalid` 失败关闭。Browser／Web 保留 host facts，Files 复用原描述链，非 Model 未命中时保留原 MCP sources→selected 回退。默认 Task 仅在普通权限中细化，Planning 的原基础描述保持。

这延续[默认装配去除重复规则](../simplification/2026-10-11-service-agent-default-composition.md)及[权限模块归属](2026-10-11-agent-permissions-module.md)的边界：Service 绑定真实来源，Agent 解释效果与策略，Core 接纳批准并最终复核派发。描述器不授予权限，不解除只读角色或扩大沙箱范围。

## Alternatives considered

- 只在 Shell 按准确 kind／定义／版本增加早返：保留该防御，但单靠它仍将无关请求交给非所属模块，未来新描述器可能再次污染事实。
- 新增通用描述器注册框架或单独 owner 表：形成第二份能力身份与同步职责；将描述器放在原注册项即可表达当前交接。
- 将普通权限和 Planning 无差别合并：会把默认 Task 的普通权限细化带入 Planning，改变独立审批要求；共享路由显式保留原视图差异。

## Consequences

原三种审批模式、只读命令限制、命令摘要、Tool／Job 独立授权、动态控制与最终执行证明保持；工具定义、协议和持久格式不升级。描述路由有唯一入口，错误身份在事实合并处拒绝，非所属描述器不再成为每次请求的隐含依赖。

实现和分支边界归[Service owner](../../../../apps/service/README.md#默认装配与业务规则归属)。[隔离路由回归](../../../../apps/service/test/isolated/capability-description-routing.test.ts)覆盖非所属调用即失败、动态身份冲突、静态能力、Task 视图、Files 元数据与 MCP 回退；既有实际调用回归另按 owner 记录。角色专属 OS 降权已评估不采用，取舍见[未采用提案](../../rejected/architecture/2026-11-03-shell-readonly-role-os-ceiling.md)；现有门禁与平台资格约束保持。
