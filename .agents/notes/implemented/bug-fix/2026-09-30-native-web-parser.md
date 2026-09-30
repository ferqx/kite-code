# Agent Note: 原生发布的被动网页解析

Status: implemented

## Problem

2026-09-30 的最新工具自测中，`web_fetch` 已通过逐跳网络准入，但原生 Service 导入 jsdom 时无法找到 `./xhr-sync-worker.js`。该依赖在模块初始化时解析同步 XHR 子进程 worker；源码模式能解析的相对文件不在 Bun 原生载荷中，使被动 HTML 提取也提前失败。

## Decision

发布 compiler 只对准确 jsdom XHR 实现路径做两处已知语法的唯一匹配适配：移除运行时同步 worker 路径解析，并让同步 XHR 发送明确拒绝。源码解析机制、正常 HTTP transport 与 Readability 提取保持原路径。上游实现变化时构建报错，必须重新核对适配。当前边界由 [Builtin Web owner](../../../../packages/builtin-runtime/docs/extensions-and-verification.md#web)维护。

## Alternatives considered

- 只验证源码模式：不能覆盖安装产物，原生回归已复现同一缺失 worker 错误。
- 把同步 XHR worker 当作额外运行时文件：会引入额外发布文件与子进程语义，而被动提取不需要 XHR；现有 Worker URL 也不是独立原生编译入口。
- 放宽或绕过网络准入：日志已证明网络准入成功，不能修复模块加载问题，也不符合现有网络边界。

## Consequences

原生 HTML 提取不再依赖这个相对 worker 文件；不执行页面脚本或加载子资源，同步 XHR 明确不受支持。适配依赖当前 jsdom 实现形状，升级时构建门禁会要求重新核对。[正式 compiler 回归](../../../../tests/release/web-extraction-compiled.test.ts)删除入口源码后实际运行原生产物，并检查标题、Markdown、绝对链接、脚本及子资源不执行和同步 XHR 拒绝。已在 macOS arm64、Bun 1.4.2 验证；这份证据不代表其他平台资格，也不表示用户正在运行的旧产物已替换。
