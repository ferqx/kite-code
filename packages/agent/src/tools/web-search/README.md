# 普通网页搜索

`@kite-ai/agent/tools/web-search` 导出 `createWebSearchExtension` 和中立的 `SearchPort`。Service 在 Run 装配时冻结提供商、账户、预算和证据发布器；主模型只看到 `web_search({query})`。准确内置身份为 `builtin.web-search/web.search@1`，效果为 `network` 和 `external`，调用经过常规权限检查。设置页的测试搜索有独立的 Action 身份和授权。原生提供商搜索由模型执行器处理。

普通工具在当前 Session 的扩展记录 `budget/<runId>` 中通过 revision CAS 预留执行 ID，默认每 Run 最多六次；宿主可以缩小额度。预留先于外部派发。并发、取消、崩溃及重启都不会恢复可能已使用的额度。同一执行 ID 的不确定预留拒绝再次调用；真实的空结果消耗一次。返回的远端资料、模型参数和子 Run 均不能改变账户。子 Run 的有效选择和角色约束由 Service 绑定。

源列表和正文引用分开保存。模型材料最多 16 KiB UTF-8；截断结果或后端回答的规范化响应可经普通 Artifact 查看。后端回答中的位置属于原回答，不能作为主模型正文的引用位置。执行证据通过当前工具执行的原始 scope 发布，已知请求数与未知用量分开保留。远端错误正文及凭据不进入返回材料。

[工具、权限和 SQLite 重开测试](../../../test/isolated/web-search/tool.test.ts) · [默认 Service 路由测试](../../../../../apps/service/test/isolated/web-search-routing.test.ts)

普通搜索在工具获准并预留本 Run 请求额度后，以原 Tool Execution、提供方和查询发布 `searching` 证据，再调用提供方；后续状态在同一调用下读取。预写失败时不会发出请求。[工具测试](../../../test/isolated/web-search/tool.test.ts)
