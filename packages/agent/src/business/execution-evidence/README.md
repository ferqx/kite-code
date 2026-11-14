# 宿主执行记录查询（模型工具已退役）

默认客户端不再注册或向模型提供 `read_execution_evidence`（内部 ID `execution_evidence.read`），不以新工具替代该入口。模型按当前可用读取工具和保留的准确操作引用查询结果；不能为找回结果重新执行操作。

Runtime 的 `readExecutionEvidence`、Store 固定范围分页、原 Tool／Job 记录、未知状态、权限和幂等处理保持。它们是宿主内部接口，不等于模型可调用能力。存储查询仍按原 Store／Session／Run 核范围，只返回公开结果，不开放私有模型正文。历史 evidence 结果的呈现保留兼容。

## 压缩后的边界

摘要应保留原执行回执、Shell 句柄、准确路径、验证结果及不确定性，但不能保证完整保真。原引用和正文均丢失时，模型已不能通过独立工具重新枚举本任务全部历史回执。`read_plan` 只能恢复计划，已保留的 Shell 句柄可用于原 Shell 读取，当前文件和累计 diff 不能证明原操作归属或成功。缺少必要证据应明确报告未知，不能推断成功或重放写入。

## 验证

[存储回归](../../../test/isolated/storage/execution-evidence.test.ts)保留 scoped 查询、分页和归属检查。[旧结果呈现回归](../../../test/isolated/execution/evidence-public-feedback.test.ts)使用仅测试的退役工厂模拟历史数据，不证明当前提供该模型入口。[压缩边界回归](../../../test/isolated/business/execution-evidence-removed.test.ts)验证默认无入口时原未知记录保留且受控模型不重放；它不是任意真实模型不会重复操作的保证。
