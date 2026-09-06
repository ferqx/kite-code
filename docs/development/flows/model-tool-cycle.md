# 模型输入、响应与工具循环

触发：调度器选择模型工作，或工具结果需要后续模型处理。

```mermaid
sequenceDiagram
  participant H as Host / Service
  participant B as Builtin context + gateway
  participant P as Model Provider
  participant K as Kernel
  participant T as Tool mechanism
  H->>B: 固定 Run 配置、State view、注入 ports
  B->>B: 构造上下文与 compiled surface
  B->>H: 请求 attempt / resource acknowledgement
  H-->>B: 已提交的执行资格
  B->>P: 当前 invocation 的请求
  P-->>B: 累计流与完整响应
  B-->>H: 模型证据、完整工具请求或正文
  H->>B: 解析工具参数与策略 facts
  H->>K: 授权/调度决策输入
  K-->>H: allow / approval / deny
  H->>T: 已接受的 prepared dispatch
  T-->>H: 结果与 receipt
  H->>B: 后续模型上下文
```

| 交接 | 对象 | 负责位置 |
| --- | --- | --- |
| 配置到上下文 | 当前 Run 的 model route 与 State view | Service 准入、Builtin compiler |
| 上下文到 Provider | surface digest、invocation、attempt | Gateway 与 Host acknowledgement |
| 响应到工具 | 完整 arguments、binding、effects/traits | Builtin parser/policy facts，Kernel 决策 |
| 工具到下一轮 | 已提交结果、Artifact 与状态 | Host/Store，再构造后续输入 |

partial tool call 不进入真实执行。活动 Run 配置不因选择器保存了新模型而改变。Provider 错误、流中断与外部工具 unknown 不能合并成同一种可安全重试错误。末尾正文不是验证和整轮完成的替代。

底层：[模型上下文](../../../packages/builtin-runtime/docs/model-and-context.md)、[工具流水线](../../../packages/builtin-runtime/docs/tool-pipeline.md)、[调度授权](../../../packages/agent-kernel/docs/scheduling-authorization.md)。验证：[Host context](../../../packages/runtime-host/test/context-compilation.test.ts)、[pipeline](../../../packages/builtin-runtime/test/tool-pipeline-callbacks.test.ts)、[effect admission](../../../packages/agent-kernel/test/effect-admission.test.ts)。
