# 历史 Runtime golden 数据

`fixtures/` 中的十份 JSON 是旧 RuntimeEvent/reducer 的确定性输入与预期状态样例，保留作历史数据参考。对应的旧 `run.ts` 和 `golden.test.ts` 已随旧 Kernel/Runtime 闭包删除；当前目录没有可执行测试，不能通过运行 `bun test tests/golden/` 取得验证结果。

当前状态、授权和恢复验证由新 [Agent owner](../../packages/agent/README.md)及其测试负责，默认执行范围由[统一计划](../../scripts/unified-test-plan.ts)确定。历史数据存在不表示新 Store 支持旧格式，也不能作为当前 reducer、模型、工具或平台能力的通过证据。
