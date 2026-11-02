# Agent Note: Windows 普通工作区配置发布

Status: implemented

## Problem

普通 Workspace 声明按既有 scope 政策允许位于继承 ACL 的目录，但配置及 MCP 来源发布临时文件误用了要求私有父目录的 writer，Windows 实际选择与变更在写入前失败。Profile、凭据与协调对象仍必须满足私有政策。

## Decision

在[原生路径 owner](../../../../packages/agent/src/platform/windows-path-security.README.md)提供 `writeScopeFile`，共享原有有限 transfer、CREATE_NEW 私有 descriptor、短写、Flush、叶子 nlink/ACL/身份及严格关闭检查，只按 host 显式选择的 scope 政策验证并持有原父目录。普通配置发布与 Workspace MCP 临时文件使用该 writer，Profile 和私有元数据继续使用 `writePrivateFile`。

## Alternatives considered

- 放宽 `writePrivateFile` 的父目录检查会影响凭据、Profile 等调用者，破坏既有私有合同。
- 把 Workspace 目录改成私有会改变用户目录权限，也不符合 scope 合同。
- 在测试中把所有 Workspace 设为私有会隐藏真实产品失败，不能证明普通工作区可修改。

## Consequences

不改变现有目录 ACL，不把工作区内容当授权，不改变协议或工具版本。平台回归明确核普通父目录不能通过 private writer、scope writer 新文件仍为私有；选择回归使用实际外部 ACL 并核父目录权限不变。外部编辑器最终检查与 rename 之间的非原子竞争仍按[配置 owner](../../../../packages/agent/src/config/README.md)保留原限制。
