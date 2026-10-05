# 开始使用 Web


Web 是本机浏览器中的只读入口，用于查看工作区、已有会话、消息、日志及模型上下文。它不提供任务输入、审批或配置修改。

## 打开页面

从源码运行时，在仓库根目录执行：

```sh
bun install
bun run server
```

该命令构建 Web 资源、显式启动本机 App Server daemon，并打印根地址。在浏览器打开该地址。

已有匹配服务时，`bun run agent web` 只打印已运行服务的地址，不隐式启动或升级进程。安装版使用对应的 `kite server start`、`kite web`。详细操作见[服务生命周期](../../server/lifecycle.md)。

## 第一次查看

1. 打开目录页，展开工作区。
2. 选择已有会话，查看 History。
3. 需要诊断时切到 Runtime logs，再按需展开条目。
4. 需要接口说明时进入 API Docs。

没有会话时先使用 TUI 或 CLI 创建任务。Web 空列表不提供创建入口。默认 TUI 不自动开启 Web 服务；直接运行 Web 的开发资源服务器也不等于拥有后端。

关闭浏览器不会停止显式 daemon。无法打开页面时先检查服务状态，再检查地址与版本，不手工编辑浏览器凭据。

页面绑定提供它的服务实例与 build，发现服务变化会提示重新加载并拒绝消费不匹配响应。重启后地址可能改变，使用 `kite web` 获取实际地址。

## 新 Agent 开发观察入口

通用 Agent 重构的新开发页面使用 `bun run build` 后的 `bun run web:dev`。它选择独立的 `development` profile，可读取该新 profile 已有的工作区、会话、完整 History、当前选择 Context 与准确 Job 输出。正式 TUI/CLI 的旧会话库不会被导入到这里；旧 `server`、`kite web` 的操作仍按上文执行。新页面已提供按需 Runtime logs、原 Model 输入检查器与当前 Service 构建的 API Docs；文件恢复点尚未迁入。日志、输入检查、当前 Context 与准确 Job 输出各按原会话和执行范围展示。实际完成范围见[实施证据](../../../plans/unified-agent-refactor-v1-progress.md)。

launcher 打印地址后需保持运行。关闭浏览器只结束该浏览器读取；在 launcher 中按 Ctrl+C 或结束其输入流，才会关闭它拥有的 Service 和 Browser Gateway。缺少已构建资产或身份准入失败时不会开放页面；具体开发选择见[本地开发](../../../development/local-development.md)。
