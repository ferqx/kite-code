# Agent Note: Auto 外部文本先隔离读取，批准后释放同一快照

Status: implemented

## Problem

所有 Files read 都先走模型审核，使普通工作区读取和根本不存在的外部文件也产生审核；直接先执行完整工具又会让未经批准的正文进入结果、事件或 Artifact。仅审核路径后重新读取还会交付与原快照不同的字节。

## Decision

普通工作区 read 使用已有 safeRead 分类。普通外部文本在 Core 完整硬门禁后通过准确可信行为私有预读，缺失只改变 Files 自己的默认分类，存在正文仍走原审核与最终派发。私有 closure 只在派发后单次生成原结果；描述器与持久记录不接触正文。执行身份、输入、根／epoch、保护范围与原 policy 都继续绑定，独立人工要求不提前读取。

## Alternatives considered

- 在 describeRequest 读正文：发生在信任、工具 allowlist 与父子硬拒绝前，不接受。
- 先产生完整 ToolResult，再阻止后继模型：已经泄露给存储、事件和 Artifact，不接受。
- 只检查存在性，批准后再读：不能实现先读后审，且容易发生路径替换，不接受。
- 直接重写组合 PermissionDecision 免审：可能绕过独立 checker；改为 Files 自身精确 metadata 分类，原组合链不变。
- 新增公开暂存 Artifact 或正文表：扩大授权与冷恢复边界；采用不持久的单次私有快照，丢失后失败关闭。

## Consequences

需要审核的读取在批准前可能已发生本地只读 I/O，但正文未发布。缺失是读取时点的观察，不承诺稍后仍不存在。文件可在审核期间变化，批准只释放已冻结字节；不自动读取新版。暂停后的取消、拒绝和技术失败清理快照，已有审核但快照丢失不重建或重放。公开 read@5、write@3、edit@2 与数据库协议不升级。

具体实现与有限验证见 [Files owner](../../../../packages/agent/src/tools/files/README.md#auto-文本读取的私有快照)。工作区执行根切换归独立 owner，本决定不以 Shell cwd 或修改共享 Workspace 代替它。
