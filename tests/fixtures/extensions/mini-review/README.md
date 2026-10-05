# mini-review

独立测试参考扩展，仅导入 `@kite-ai/agent/extensions`。不自动进入正式装配，不增加正式 Review 产品或审批要求。

`createMiniReview()` 返回扩展与本地分析调用计数。`analyze` 先通过 ReadContext 核对当前 Session 的 source Run/成功 Execution，保存含来源及结果版本的 executable 计划，再以调用者提供的稳定 business key 调用受控固定分析工具并保存 findings。findings schema 保留未来新增字段，并继续要求当前已知字段。已有 findings 的相同业务身份直接返回已保存结果，不调用 ensure、不改变原 operation 的父动作关系；不同准备内容不能覆盖相同身份。再次分析需要用户填写新的明确 business key。

`mark` 只对扩展自有 findings 记录做 CAS 更新，合并保留其他字段，不创建模型 Run。`results` Query 只读取已保存记录，输出通用 PublicView 的 summary、payload、artifactRefs 与动作；没有专用 renderer 时仍可展示。计划与结果内容分别注册 schema 与版本。

验证：`bun run --cwd tests/fixtures/extensions/mini-review typecheck`、`build`、`test`，以及根真实 Service→Client 外部扩展集成测试。分析内容是固定 fixture，不调用付费模型、文件系统或用户数据。
