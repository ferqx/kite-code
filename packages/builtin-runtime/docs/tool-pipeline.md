# 工具契约、解析与执行流水线

入口：[catalog contract](../src/catalog-contract.ts)、[tool contracts](../src/tool-contracts.ts)、[schemas](../src/tool-schemas.ts)、[pipeline callbacks](../src/tool-pipeline-callbacks.ts)、[prepared dispatch](../src/builtin-prepared-dispatch-adapter.ts)。

## 从模型声明到实际执行

工具声明由同一契约提供描述、schema、parser、effect 分类和可用性。模型传来的 JSON 不直接进入执行器：先解析成规范参数，再结合能力绑定和当前上下文编译策略 facts。描述不能宣称 schema 或执行器未支持的行为。

Host coordinator 维护 attempt 和提交身份，Builtin callback 提供实际机制；Service adapter 注入 filesystem、Shell、MCP 和子任务依赖。Kernel 决定授权与调度，Builtin 不能以“执行函数可调用”绕过这些决定。

| 交接 | 必须保持 |
| --- | --- |
| 模型声明 → parser | 同一 schema，错误不能变成默认参数继续执行 |
| parser → policy | 使用规范化参数与 effect facts，不再使用未解析原文推导权限 |
| preparation → dispatch | exact capability/attempt/参数 identity |
| 外部结果 → receipt | 区分成功、拒绝、失败、取消和 unknown effects |
| receipt → verification | 只引用已提交成功事实与真实 Artifact |

Subagent suspension 的等待事实绑定已解析参数；不能将 raw input 摘要作为第二执行身份。重试要保留正确的已执行/未执行边界，不通过重复调用制造一次成功结果。

## 新增工具时

先定义产品目的和输入输出，再选择现有 owner module，补全声明、解析、effects/traits、机制与 terminal 投影。把生产注册、模型披露、策略与验证一起核对；不要仅在测试注册工具。

规范见[工具契约](../../../docs/active/tool-description-contracts.md)、[工具自治](../../../docs/active/tool-gated-autonomy.md)。验证：[pipeline](../test/tool-pipeline-callbacks.test.ts)、[runtime callbacks](../test/runtime-tool-pipeline-callbacks.test.ts)、[Subagent schema](../test/tools/subagent-schema-conformance.test.ts)。
