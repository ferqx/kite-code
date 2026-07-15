# 当前规则：真实模型测试边界

状态：active

读取时机：新增真实网络/模型测试、修改测试发现规则、package scripts 或声明 provider 端到端验证结果时。

验证：`bun test tests/test-discovery.test.ts`、`bun run typecheck`。

相关：`model-provider-boundary.md`。

## 当前状态

仓库当前没有注册 `test:real` package script，也没有受维护的真实模型测试文件。默认 `bun test` 只应运行确定性的本地/mock 测试。文档、PR 或完成记录不得把 mock model 集成测试表述为真实 provider 验证。

## 新增真实套件的要求

1. 文件不得使用会被 Bun 默认发现的 `*.test.*` 或 `*.spec.*` 名称。
2. 必须提供显式 package script/wrapper，且默认测试不能调用它。
3. Wrapper 必须限制并发和超时，不得硬编码 provider、密钥或代理清理策略。
4. Provider/model 可显式选择，连接信息来自用户环境或隔离配置。
5. 测试输出不得记录 API key、完整请求、敏感 prompt 或用户配置。
6. 必须更新 `tests/test-discovery.test.ts` 防止真实套件进入默认发现。
7. 完成记录应注明 provider、模型、日期、网络条件和实际运行命令。

真实套件不存在或未运行时，只能报告本地 mock/contract 验证结果。
