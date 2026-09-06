# ADR-0178：桌面 macOS 退出先确认并等待服务清理

**Status**: accepted

**Date**: 2026-09-07

**Decision makers**: @chenchao

## Context

已确认的桌面设计要求关窗继续、明确退出时确认并收尾。原生验收发现默认 macOS Quit 使用 Cocoa termination，直接终止进程，未经过应用已有的 Tauri `ExitRequested` 确认。只验证 Rust carrier EOF 或前端构建不能发现这个入口差异。

## Decision

在 AppKit 主线程 setup 时，为当前应用 delegate 安装不增加 ivar 的子类，仅实现 Cocoa 的 `applicationShouldTerminate:`，保留现有 Tao delegate 的布局和其他方法。该回调先取消 Cocoa 的立即退出，再提交 `AppHandle.exit(0)`，进入已有 Tauri 的可取消退出流程。

退出确认绑定主窗口；用户返回则保留应用，用户确认后阻止新的连接并关闭当前 stdio，等待 Service 收尾。`quitting` 与清理完成后的 `exit_allowed` 分开，重复退出请求不能跳过在途清理。Service 的任务和持久状态仍由原 owner 管理，native delegate 不拥有任务计数、Store 或重试队列。

## Alternatives

- 只保留 `ExitRequested`：实际默认 macOS Quit 未进入该路径，无法兑现产品行为。
- 只替换 Command-Q 菜单项：不能覆盖经同一 Cocoa termination 入口进入的系统 Quit 请求。
- 在原生回调里阻塞等待任务：阻塞 AppKit 主线程，妨碍确认和 UI 响应。
- 另建后台管理进程：超出当前自有 Service 生命周期要求。

## Consequences

该平台适配包含有明确布局/ABI 前提的 Objective-C interop；Tauri/tao 升级需重复原生退出验收。崩溃或强制终止继续依靠已有 EOF 与服务清理，不虚构可拦截所有 OS 强杀。当前实现、验证与限制完整维护在[桌面 owner](../../apps/kite-desktop/README.md)及[原生验收](../../apps/kite-desktop/docs/native-validation.md)。
