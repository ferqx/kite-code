# Public API 数据契约与生成产物

入口：[schemas](../src/schemas.ts)、[codecs](../src/codecs.ts)、[limits](../src/limits.ts)、[generation](../src/generation.ts)。本包无 workspace 依赖，提供 browser-safe Public wire。

Public Workspace、Session、History、logs、checkpoint 和模型上下文是允许暴露的 DTO，不是 Raw Store 的序列化。opaque identity、cursor、after_sequence、capabilities 与 problem shape 各自承担定位、分页、增量、准入和错误职责。

Service 构造并校验响应，typed browser client 再解码。规范中存在 route 不代表当前 principal 或发布 capability 可调用；访问权必须由服务实际状态决定。

生成脚本从 canonical contract 产生 OpenAPI 等 committed artifacts，Web build 逐字节装入规范资源。generator 不是 Runtime export，不由浏览器重新生成；变更需核对 schemas、codec、artifact 和真实 consumer。

验证：[contract tests](../test/)、[客户端 tests](../../agent-api-client/test/client.test.ts)，跨包契约见[Agent API](../../../docs/active/agent-api-contract.md)。
