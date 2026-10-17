# Agent Note: Artifact 读写共用资源的有界接纳

Status: implemented

## Problem

用户要求多个主 Agent 各自调用多个子 Agent 时，读取切换、中断和服务器压力都不损坏真实执行。实际8主／24子持续 Model 输出叠加6个正文 GET，原 Artifact Store 的8个活动操作一满就立即抛 `artifact_busy`。读取洪峰既能使 GET 返回503，也能令模型持久发布失败；Native 的4主／12子窗口另有4个真实子 Model 因同一原因失败。执行配额与磁盘资源接纳是两件事，只增加模型槽位不能解决它们的竞争。

## Decision

正常拥塞超出正式票据预算后直接 `artifact_busy` 的决定，已由[正常Loop检查点决定](../bug-fix/2026-10-17-normal-loop-checkpoints.md)部分取代：额外调用等待共享容量，bytes便利入口以私有snapshot维持调用时封存。本文的8/6活动上限、64/32正式票据、16MiB内存预算、公平和不重放理由继续适用；当前行为与验证以[Artifact owner](../../../../packages/agent/src/artifacts/README.md)为准，以下原实施证据不代表当前仍对正常拥塞直接失败。

保留8个活动 Artifact 操作，读取最多占6个；新增有界、可取消的排队，等候总数64、读取32、metadata与已知字节数组16MiB。发布获得有限优先权，每批最多连续交接4次后让等待读取前进。超出接纳预算返回可重试的 `artifact_busy`，不裁剪完整正文，不把排队预算变成 Artifact 总大小限制。

排队票据在调用时固定 metadata与scope，字节数组发布在取得接纳资格后复制调用时 bytes。取消立即移除等候读取且不查询 Store；Runtime 的原正文取消信号沿 Artifact 中立端口传递，不进入 Worker。close 拒绝新工作，排空此前接受的活动与排队操作后释放 Profile 使用权。完整 EOF／hash／size、准确引用授权、不可变文件身份和原发布顺序保持。

## Alternatives considered

1. 仅提高原8个活动操作上限：仍会在下一次读取洪峰立即拒绝业务发布，并放大磁盘和 Worker 竞争，未采用。
2. 无界排队或让读取占满全部等待位置：会保留任意数量的大载荷，且持续读取仍可饿死发布，未采用。
3. 遇到持久发布失败后重新执行 Model：可能重复付费与外部效果，且改变已发生的执行事实，未采用。接纳失败明确返回原错误，调用方不取得重放权。
4. 用正文缓存绕过原引用或文件校验：会改变读取授权与不可变内容核实，不属于本次资源调度修复，未采用。

## Consequences

读取与发布在有界磁盘操作上共享进展，过载仍显式失败。该机制不增加生产 Model 默认并发配额，不保证任意流量零排队；惰性 source 闭包的任意外部保留量无法由票据字节精确计量。完整 Model 快照仍会重建和校验，wire分块不能解释为整个请求使用固定内存。

当前参数与测试归 [Artifact owner](../../../../packages/agent/src/artifacts/README.md)，真实默认4槽及可信隔离16／32槽的压力、取消语义和资源测量归 [Service owner](../../../../apps/service/README.md#多主子会话流与读取压力)。本机有限窗口的通过不能证明长期 RSS 平台、远程模型吞吐或三平台资格。
