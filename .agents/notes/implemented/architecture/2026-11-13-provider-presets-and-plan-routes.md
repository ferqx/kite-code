# Agent Note: 提供商预设与编程套餐路由

Status: implemented

## Problem

同一模型品牌可以有普通 API、由普通 API 抵扣的资源包、以及使用独立密钥或地址的编程套餐。只列品牌名会让用户混用密钥、地址和模型 ID；以同一方式发现模型也无法覆盖各家的目录端点。OpenCode Go 当前入口还要求按会话发送路由标识。

## Decision

桌面新增表单提供按接入方式命名的快捷模板，并提示地址、协议和 key 来源。新增模板写入原 compatible 连接；套餐和普通 API 在用户保存后仍是独立命名的实例。资源包如只改变服务商侧结算，不另设客户端模板。没有通用模型目录的预设要求明确填写模型 ID。明确限制指定客户端的套餐只记录官方参数和适用范围。

Service 仅对 OpenCode Go 的现行准确订阅地址追加真实客户端标识及会话 ID 摘要，并拒绝重定向。它与[发布 smoke 固定的历史入口](../process/2026-08-09-opencode-go-release-provider-smoke.md)独立，不迁移既有连接或改变发布证据。

## Alternatives considered

- 按品牌或计费方式新增 Provider family 与持久字段：现有连接字段足够表达同品牌不同凭据和路由；新 family 会使表单模板影响稳定模型身份、准入及恢复。
- 统一按品牌预填模型或留空时一律发现：套餐可能限制模型目录或使用不同 URL，自动写入目录容易导入账户不可用的模型。让用户填写实际账户模型 ID 会多一步，但不会猜测模型或跨计费路线探测。
- 沿用旧 OpenCode Go 入口作为新模板：现行官方文档已使用新的 inference 地址，并要求会话标识；保留旧连接的原行为，新的连接按现行合同配置。

## Consequences

用户只在桌面选择预设，TUI 与 CLI 继续读取同一用户配置，Web 保持只读。套餐余额、计费和支持名单由服务商决定。参数、限制和操作见[产品手册](../../../../docs/handbook/features/models-and-configuration.md#服务商预设与套餐)，实际设置和模型请求的验证入口归 [Desktop](../../../../apps/desktop/README.md#native-provider-与下一次模型选择)和 [Service](../../../../apps/service/README.md)。
