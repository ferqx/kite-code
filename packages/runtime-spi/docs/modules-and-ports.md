# Runtime modules、Registry 与注入 Port

入口：[modules](../src/modules.ts)、[registry](../src/registry.ts)、[capability](../src/capability.ts)、[tool pipeline](../src/tool-pipeline.ts)、[model](../src/model.ts)。SPI 是 provider-neutral 的依赖注入边界，不导入 Host、SQLite 或客户端展示。

Service 构造 modules 和 concrete ports，registry 注册 capability 并形成 frozen snapshot，Host 使用该快照执行。运行时不能再由调用者插入第二套动态 reducer 或任意 executor 覆盖已经绑定的能力。

Capability 关联声明、effects、input/output、mechanism 和绑定信息。调用时校验 revision/digest 与 identity；catalog、披露、binding 和 dispatch 分别承担不同职责。一个 snapshot 不代表所有能力都已被允许执行。

Model、filesystem、sandbox、credential、Subagent 等 port 明确输入输出和取消上下文。纯 JSON facts 与 I/O handles 分开，不把 Provider handle 存入 Kernel State。

新增 port 前确认是否已有同职责接口和生产消费者。给测试注入函数不能成为添加通用扩展框架的唯一理由。验证：[SPI tests](../test/)、[Builtin 注册](../../builtin-runtime/test/builtin-runtime.test.ts)。
