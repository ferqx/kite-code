# 协议编码、版本与传输边界

入口：[codecs](../src/codecs.ts)、[mappers](../src/mappers.ts)、[limits](../src/limits.ts)、[generation](../src/generation.ts)。本包将 Runtime contract 编成严格、browser-safe、framing-neutral wire，不执行命令。

请求、回执、通知和查询结果必须通过对应 codec。exact version、允许字段、大小限制和错误形状由该包决定；不能让未知字段进入 raw Runtime event。Service carrier 处理实际 framing 与传输，Protocol 不创建 socket 或进程。

连接 request identity 用于关联 wire response；业务 command identity 和 Session revision 用于幂等及状态校验，二者不能混用。连接重建不允许自动重放未知副作用命令。

修改 contract 后同时核对 mapper、codec、producer 和 consumer。只有输出字段的投影允许时才能新增客户端信息；生成参考不替代运行 codec。与 Public Agent API 的关系见[整体依赖](../../../docs/development/architecture/dependencies.md)。

验证：[Protocol tests](../test/)、[Server tests](../../runtime-server/test/runtime-server.test.ts)、[Client tests](../../runtime-client/test/runtime-client.test.ts)。
