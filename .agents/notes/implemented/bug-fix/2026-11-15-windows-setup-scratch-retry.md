# Agent Note: Windows 安装暂存目录共享冲突的恢复

Status: implemented

## Problem

首次安装发布候选并写入 `active` 后，暂存目录仍可能被短暂占用。删除句柄获取返回共享冲突时，原收尾把它合并为 `native_windows_close_unknown`。Windows 向导没有得到成功回执，跳过应用登记和快捷方式创建。

## Decision

在受管安装持有原选择锁时，只对获取阶段已确认完成回收的共享冲突限时重试。继续使用原有限库存，成功获取后交由原删除 owner 核验并关闭。只有原安装操作成功且该清理重试超时时，向导才提供留在原目录的重试。若原安装另有错误，保留首个错误和收尾错误。Windows 登记仍由已核对成功回执的向导执行。

## Alternatives considered

- 每次遇到共享冲突都重跑整个安装。这样会释放原选择锁并重复已完成的发布工作，扩大了重试范围。
- 将暂存清理失败当作成功并继续登记。这样会将真正关闭未知的情况交给后续步骤，而原 owner 尚未确认资源状态。

## Consequences

短暂占用会留在当前安装进度中；持续占用需要用户关闭占用程序后重试。下一子进程复用已核验、已发布的候选，本次超时遗留的暂存目录仍在私有协调目录内。原删除安全约束沿用 [Windows 原对象决定](2026-10-17-windows-original-object-sharing.md)，实际用户行为和验证归 [Native owner](../../../../apps/desktop/docs/native-release.md#构建与安装)。
