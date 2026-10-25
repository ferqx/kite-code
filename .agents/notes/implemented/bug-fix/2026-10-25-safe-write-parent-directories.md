# Agent Note: 工作区新文件安全补齐父目录

Status: implemented

## Problem

真实 Desktop 会话在空工作区新建 `examples/agent_demo.py`，三次自动审核批准后均因父目录不存在返回裸 `ENOENT`。模型重复相同写入并将空目录误判为项目未加载。用户明确要求写入工具安全补齐父目录并解释失败原因。

## Decision

`files.write@3` 仅在 `base:null` 时补齐工作区内的缺失父目录，沿原 native 能力逐段创建、核身份及关闭；新建目录使用本人私有权限，不放宽原链接、保护、别名与 root 检查。原父对象上的 `EEXIST` 竞争只重开一次，不转为绝对路径操作。ABI2 拒绝旧 companion，避免旧后端承担新语义。

已知失败可以留下目录，不删除它们；文件检查点只恢复文件，恢复工具也不扩张为创建目录。原生取得／关闭不确定仍进原 unknown/pending。失败保留原因、原请求路径和操作建议，要求处理原因后再尝试；不以重复次数或路径历史新增权限拒绝。

## Alternatives considered

- 让模型先用 Shell 创建目录：当前 Windows Shell 能力有限，且无法修复文件工具本身对普通新文件的处理；未采用。
- Node `mkdir({recursive:true})` 后回到原文件工具：会引入第二个绝对路径 authority，无法保持原父句柄和 no-follow 规则；未采用。
- 失败时递归删除新目录：可能删除其他写入者后来放入的内容，并把文件检查点扩张为目录恢复；未采用。
- 对同一路径重复请求直接限次拒绝：不同参数和修正后的操作仍可能合法，原因提示可支持模型纠正而无需新增审批规则；未采用。

## Consequences

工作区覆盖／编辑、外部写入及字节恢复保持原父目录要求；未形成目录事务或目录回滚承诺。旧文件检查点来源继续可读，准确新版本另行核授权。当前机制和本机验证归 [Files owner](../../../../packages/agent/src/tools/files/README.md#新建文件的父目录与失败反馈)，用户行为归[工具手册](../../../../docs/handbook/features/tools-and-approvals.md)。
