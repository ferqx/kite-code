# Agent Note: Verify session roots for files and Git worktrees

Status: implemented

## Problem

Windows 普通 CSV 读取把 Bun `lstat` 的目录设备标识与 `FILE_ID_INFO` 的卷序列号直接比较。同一个目录也会返回 `execution_root_changed`，普通检出与链接工作树均受影响。Git 列表会从嵌套目录向上发现仓库，切换却要求直接验证 checkout 登记。测试夹具因此拾取了所属应用仓库的工作树登记，`use` 又只返回笼统失败。

## Decision

文件快速核验与实际文件操作都把已验证的会话根身份传入各自使用的原生 owner。Windows 先通过不跟随重解析点的句柄固定根和祖先，再以 Bun `lstat` 核对会话使用的目录身份。原生文件基线继续用卷号及 File ID。 [Files owner](../../../../packages/agent/src/tools/files/README.md#windows-workspace-文件源码)

工作树列表、变更和切换都使用受授权根限制的仓库核验。切换以源和目标的真实登记、同仓库身份及实际路径为依据，派发时重新检查物理状态，以原派发权限快照中的同一摘要核对源和目标。授权阶段无需另存临时选择。仓库核验失败沿原回执给出可区分的错误。 [Worktree owner](../../../../packages/agent/src/tools/git-worktree/README.md)

## Alternatives considered

- Windows 上停用读取快路径可先恢复读取，但会让普通工作区文件重新经过通用上下文选择。原生句柄已经能固定目录，保留快路径可复用这次打开完成身份核对。
- 将会话身份整体改为原生卷号和 File ID 会同时改变已封存的执行根、恢复和审批。当前问题可以在文件 owner 的边界内解决。
- 直接沿用 Git 的隐式祖先发现会把未授权父仓库元数据带入列表。把边界限制应用到仓库发现和切换，两条路径可回答同一个目录是否属于已验证仓库。

## Consequences

在已登记的真实工作树上可继续按原会话根读取普通文件。已替换的目录和指向未授权仓库的普通子目录会被明确拒绝。Windows 本机定向证据归 [文件读取](../../../../apps/service/test/isolated/files-native-boundary.test.ts)与[工作树同轮集成](../../../../apps/service/test/isolated/session-execution-root.test.ts)。
