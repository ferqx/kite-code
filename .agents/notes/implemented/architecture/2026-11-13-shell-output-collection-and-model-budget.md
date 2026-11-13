# Agent Note: Shell 输出采集与模型回执独立限量

Status: implemented

## Problem

Windows 桌面会话中，两次普通检索各省略超过 22 MB 输出，其中一次限制了下游行数，仍产生 5,300 次输出记录。现有保留上限用完后继续逐块持久化省略计数，只保留输出前缀。长行可能占据大量输出空间，模型也可能收到远大于实际需要的回执。

## Decision

普通 Shell 采用 1 MiB 头尾保留预算。前缀可实时读取，尾部在终态前和省略字节数一起发布，确保已经读过的游标位置不会被替换。模型回执独立使用默认 10,000 token 的近似预算，受原 Run 所选模型已知输入容量约束。Shell 继续排空输出并观察原进程终态。当前行为和回归归 [Jobs owner](../../../../packages/agent/src/jobs/README.md) 与 [Shell owner](../../../../packages/agent/src/tools/shell.README.md)。

## Alternatives considered

- 在提示词固定行数与行宽。用户明确选择通用 Shell 的字节与 token 两层预算，搜索结果可按实际需要超过该行数。
- 在持久化后逐块更新省略数。持续大量写入仍会增加 Store 和输出事件负担。
- 达到保留预算就停止命令。会使普通 Shell 的副作用和终态受输出量改变，用户只确认了输出限量。

## Consequences

超量输出运行期间可见的是稳定前缀，结束时可读保留尾部和缺口。可重读已保存的输出页，采集阶段省略的原字节无法从该回执恢复。工具和协议版本沿用原值。受信 Git 工作树 worker 的完整帧读取继续使用原路径。
