# Trace 引擎

本 Service 私有叶模块在独立 Bun 进程与 QuickJS 0.32.0 WASM 隔离区中，执行已经校验并在本地安装的 Trace bundle。它不负责安装、授权、事件投影、凭据、HTTP、队列成员关系或 ACK 持久化。可信 TraceHost 通过有上限的 `broker(method, input, {generation, signal})` 回调提供这些决策；runner 只接收 JSON 副本。

`buildTraceEngineAssets()` 生成自包含的 runner JavaScript bundle、选定的 release-sync WASM、空 Bun/TS 配置和闭合的 SHA-256 manifest。Host 将已认证的 manifest 摘要传给 `createTraceEngine`，启动前校验每个文件。运行时不回退到项目源码、包解析或未构建 TypeScript。Service／发行 owner 必须把这些资产及选定 QuickJS 依赖的许可声明纳入实际构建／安装闭包。

V1 引擎 bundle 由单个 JavaScript 脚本、API version 和摘要组成。构建后的入口调用 `defineTraceExtension({initialize?, onEvents, flush?, shutdown?})`。外部静态、动态和 native import 均不可用；SDK／模板构建必须把本地 import 打包进该脚本。`trace.request(method, input)` 是唯一 Host 桥。QuickJS 中没有 `process`、`Bun`、`require`、Host `fetch`、文件系统或 WebAssembly API。引擎不暴露 Host 对象，也不提供通用 state/outbox API。

Guest heap、stack、解释器执行、回调墙钟时间、JSON 消息、broker 调用次数与并发均有有限预算。Guest bootstrap 捕获序列化内建函数，并在跨隔离区复制前限制字符串大小。Promise 工作按有限轮次推进。Host broker 失败只返回有限错误，不传任意异常文本。引擎 stdout 使用严格私有协议；stderr 有限量排空，不暴露给扩展。

启动使用私有临时 cwd、干净环境、精确 runtime/runner 路径和已认证空配置。退休封存新调用与 broker 回复，中止 broker 托管，终止原 runner，并等待它的真实 `exit` 回执及三个 pipe 全部关闭；迟到的 broker 完成结果被丢弃。原引擎仍存活或退出未确认时，同一安装不能运行替代引擎。成功退休后释放 cwd 与 scope；清理未知时，`shutdown()` 不报告成功。

当前进程证据覆盖的是确切的原 runner 根进程。QuickJS 隔离区不暴露创建 guest 子进程的能力。这不构成 OS 文件系统／网络 sandbox，也不代表配置了 Windows Job、Linux namespace 或 macOS Seatbelt。跨平台引擎、进程和安装资格仍单独核验，本 owner 不继承 Browser 域资格。

[引擎测试](../../../test/isolated/trace-engine.test.ts) 在当前主机上构建真实 runner 资产并运行两个独立 guest bundle，覆盖异步 broker 投递、禁用的全局对象／import、CPU／heap／stack／消息／调用上限、真实根进程／pipe 关闭、bundle／资产完整性、活动 scope 排他，以及 broker 调用期间退休并迟到回复的情况。这些检查不证明后续 grant/queue/broker 业务策略、Runtime 吞吐、所有目标平台或已安装产品的资格。
