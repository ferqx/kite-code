# Public API 数据契约与生成产物

入口：[schemas](../src/schemas.ts)、[codecs](../src/codecs.ts)、[limits](../src/limits.ts)、[generation](../src/generation.ts)。本包无 workspace 依赖，提供 browser-safe Public wire。

Public Workspace、Session、History、后台执行快照、logs、checkpoint 和模型上下文是允许暴露的 DTO，不是 Raw Store 或 Runtime DTO 的序列化。后台执行项使用closed字段集，只暴露identity、kind、status、cleanup与可选cursor；opaque identity、cursor、after_sequence、capabilities 与 problem shape 各自承担定位、分页、增量、准入和错误职责。

Service 构造并校验响应，typed browser client 再解码。规范中存在 route 不代表当前 principal 或发布 capability 可调用；访问权必须由服务实际状态决定。
Model Context 的wire是有固定页大小的base64片段、opaque cursor及只读SHA-256；完整provider-neutral投影在客户端核对页身份、总长度和摘要后组装。完整文本没有累计字节或条数截断，单页仍受Public response大小与closed字段保护。

生成脚本从 canonical contract 产生 OpenAPI 等 committed artifacts，Web build 逐字节装入规范资源。generator 不是 Runtime export，不由浏览器重新生成；变更需核对 schemas、codec、artifact 和真实 consumer。

验证：[contract tests](../test/)、[客户端 tests](../../agent-api-client/test/client.test.ts)，跨包契约见[Agent API](../../../docs/active/agent-api-contract.md)。
