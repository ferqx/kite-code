# Web REST 接入与更新

产品预期：[更新与连接](../../../docs/handbook/clients/web/guides/updates-and-connection.md)。唯一生产 adapter：[transport/client](../src/transport/client.ts)。

Browser adapter 只消费 browser-safe agent-api-client → agent-api-contract，不导入 Native、Host、Store、Protocol、SQLite 或 Service raw source。组件只消费本地 presentation type。

同源 `/v1` 验证 browser principal 能力；workspaces 独立分页，首个 workspace 可预取 Sessions，其余展开读取。Session 选择读取 history 与 checkpoint metadata，logs 独立按需读取。

selected Session running/waiting 且页面可见时，约 2 秒单飞读取 after_sequence History 并刷新 Session projection；page 生命周期停止对应工作。logs 只显式刷新，不新增第二个 scheduler。失败保留最后快照并显式错误，不恢复旧 bootstrap、WebSocket、SSE、BFF 或离线 fallback。

index 响应建立 HttpOnly/SameSite Browser session，JavaScript 不兑换 launch token、不持有 Native bearer。读取因 session 到期返回401时，transport通过同源browser-session POST单飞建立替代session，并将原读取有界重试一次；不滑动续期、不增加后台刷新scheduler。document pagehide 调用 browser-session DELETE，route change 不清理。关闭浏览器不停止 daemon。

验证：[transport](../test/transport.test.ts)、[app lifecycle](../test/app-lifecycle.test.tsx)。公共边界见[Agent API](../../../docs/active/agent-api-contract.md)。

实际测试覆盖与尚未证明的轮询场景见[Web 验证](testing.md)。

## 分页边界

transport 自动追踪 next_cursor，每次读取最多 32 页；工作区、会话和恢复点请求每页 100 项，History/日志每页 200 项。超过 32 页且仍有 cursor 时返回 protocol_error，不返回部分成功。首次读取与后续增量均受此限制，日志刷新当前从起点重读。界面没有手动翻页控件；发生上限错误不能据此判断数据已删除。实现与上限定义见 [transport](../src/transport/client.ts)。
