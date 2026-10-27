# Web 只读查询

显式 daemon/Web 或开发 Web 宿主提供只读 Gateway，浏览器使用同一公开 Client 的只读能力消费 Workspace、Session、消息与诊断。UI 共享展示不扩大 Browser principal 的权限。

实现与局部验证：[Web](../../../apps/web/README.md)、[Gateway](../../../apps/service/README.md)、[Browser Client](../../../packages/client/src/browser.ts)、[Web controller](../../../apps/web/src/controller.ts)。

目录与分页保原 Store、Workspace、Session、游标和选择代次；旧请求晚到不能覆盖新页面。完整 Model Input、Runtime logs 等敏感内容按实际能力和显式确认读取。Browser 不持有 Runtime、Store、Provider 凭据或普通 mutation 权限；关闭页面不取消后台任务。

共同约束以[当前八 workspace 边界](../../active/unified-agent-boundary.md)及对应 owner 为准。定向测试、真实客户端过程和平台资格分别说明，不从源码存在或最终截图推定完整行为通过。

旧 Host/Kernel/SPI 实现的[历史说明](https://github.com/ferqx/kite-code/blob/d5407cfe4319c5a84d530f63b1d0a0123218ad34/docs/development/flows/web-queries.md)只供删除前设计与证据追溯，不能恢复为当前 owner 或运行入口。
