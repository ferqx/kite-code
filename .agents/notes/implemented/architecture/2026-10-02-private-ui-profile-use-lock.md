# Agent Note: 私有 UI 数据库独立持有稳定 profile 使用锁

Status: implemented

## Problem

Desktop 私有草稿库和 Core 数据库属于同一个可替换 profile。只依赖配套 Service 持共享锁，会在 Service 退出或崩溃而 Electron 私有库仍打开时允许维护进程切换目录。仅把正常关闭顺序调换，不能覆盖意外退出。V1.3 §18.1、§20.5、§22.2 要求真实 UI 用户数据参与同一外部维护协调。

## Decision

[Desktop main](../../../../apps/desktop/electron/main.ts)在打开私有 SQLite 前独立取得同一 profileAccessKey 下的 profile-use 共享 OS 锁，数据库真正关闭后才释放。Node 保持原文件描述符，经过私有构建、固定摘要的一次性 Bun helper，在继承的 fd 3 上取得 shared/nonblocking flock。helper 的 close/退出只释放它自己的 fd 副本，Node 继续持同一 open file description；不调用 LOCK_UN，不建立常驻服务或新的锁命名空间。

[Agent profile-access](../../../../packages/agent/src/platform/README.md)复用平台锁的 canonical 路径、私有 uid/权限、单链接、dev/ino 和未完成 journal 校验。继承入口不创建缺失 namespace 或 profile。纯 `./profile` 仍只选择身份，Node 不直接加载 bun:ffi。Desktop 构建器将 helper 构建到当前发行目录并给 main 固定相对资产名和 SHA；运行时验证 helper 与选定 Bun，不能回退到源码或 PATH 程序。

[Node lease](../../../../apps/desktop/electron/profile-access.ts)使用模块私有身份约束一份 lease 对应一个 SQLite 生命周期。已 attach 的 lease 不能提前关闭；失败开库释放所属 fd，SQLite close 失败保留锁。helper 的 close 事件确认输出流和进程退出，超时或超长输出先结束所属 helper，再处理失败。Service 独立死亡不会释放 Node 所有的共享锁；Node 被强杀由 OS 释放其 fd。

TUI 宿主同样通过公开 `acquireProfileAccess` 独立持有原共享 lease。公开 `acquireProfileDataLock(access,'tui_private')` 只为该真实、仍有效的原对象取得固定外部 `tui-private.lock` 的 nonblocking exclusive 短锁，供私有 JSON 文件 CAS 发布使用。它不接受路径或维护权限，复用平台 OS 锁与原 fd/namespace/journal 校验。短锁未释放时关闭父共享 lease 明确拒绝并保锁，因而写入不会脱离维护协调。

## Alternatives considered

- 依赖配套 Service 的共享锁：它的生命周期不覆盖 Node 私有库，真实崩溃窗口不安全。
- 只调换正常 shutdown 顺序：可以缩小正常退出窗口，但不能覆盖 Service 意外退出，不能作为完整修复。
- 常驻锁代理进程：增加需要独立监督的进程生命周期；现有 POSIX fd 继承可以让真实使用者直接保有锁，因此不采用。
- 让 helper 显式 unlock：flock 绑定共享的 open file description，会解除 Node 仍需要的锁，因此仅 close 自己的副本。
- 以 PID、mtime 或 profile 内新锁文件协调：既不能提供现有 OS 排他性，也不能跨目录替换保持同一对象，不采用。
- 为 TUI 复制 FFI 或公开任意 lock path：会分裂锁实现或扩大宿主写权；固定用途的短锁复用现有平台实现，并将生命周期绑定到原共享 lease。

## Consequences

这是一条明确 POSIX 适配路径，当前实际证据仅 macOS、Node/Bun 和 Electron 开发产物。Linux 源码支持尚未建立本轮资格，Windows 继承 fd 路径明确拒绝，不能从 POSIX 结果推断其支持。

实际平台测试验证两 Node shared、维护 exclusive busy、无关子进程退出、正常关闭和 SIGKILL 只释放所属副本；foreign fd、链接、权限、journal 和缺 namespace 拒绝。实际窗口验证 Service SIGKILL 后私有库仍打开时维护继续 busy，其他 profile 可备份，正常 UI 关闭或所属 Node SIGKILL 后可取得维护权；持排他锁或未完成 journal 的启动诊断不创建空 UI 库，Model 调用为零。单次窗口含16条Node断言，完整 Native 组合另由实施进度记录。

[短锁测试](../../../../packages/agent/test/isolated/profile-access/data-lock.test.ts)验证真实竞争、原对象/关闭/维护权限拒绝、父子释放顺序、私有权限与链接/journal/coordination 变化；与原 profile、backup、restore 组合23项226条断言通过。这些平台事实不替代 TUI 草稿编辑、冷启动或完整平台资格。

该边界允许[配置/UI独立备份](2026-10-02-offline-profile-backup.md)和[显式恢复](2026-10-02-journaled-profile-restore.md)在同一排他锁内处理已关闭 UI 数据；它不把配置/UI的独立采集时间变成跨介质原子时刻，也不证明安装、断电或完整三平台资格。
