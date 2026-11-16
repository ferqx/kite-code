# Agent Note: 显式会话执行根与原子切换

Status: implemented

## Problem

会话执行期间创建工作树后，Files 的区内外判断、Shell cwd、审批和项目指令不能各自猜目录。共享 Workspace 仍被其他会话及父子身份使用；已派发后台任务也不能被后来切换迁移。退出必须回原工作区而非删除工作树。

## Decision

保留现有 `git.worktree@1`，增加明确 `use/exit`；用户明确要求不升版本、不另设协议兼容分支。创建、通知与 Shell workdir 均不激活。只改当前 Session 私有 host 根绑定，逻辑 Workspace 不变；原 Model 响应只有这个 Tool 时，Store 才将成功结果、epoch 历史与当前根一起提交。审批前封真实来源／目标身份，执行前重验，失败或取消不激活。

下一 step 使用整套可信 binding。历史 Model 恢复读原 epoch，已派发 Job 保原 scope 和 Run lease；所有 epoch assembly 随原 lease 最终收口。父权限上限保持，新 child／Fork 独立继承准确来源根；既有子会话不改。退出回原 Workspace，检查点按物理根隔离，旧记录不删除。

此决定只取代[原 Worktree 决定](../feature/2026-11-06-git-worktree-tool.md)中“不提供会话执行根切换”的范围；原 Git 操作、删除保护、未知结果及平台限制继续适用。当前完整合同归[Worktree owner](../../../../packages/agent/src/tools/git-worktree/README.md)、[Service](../../../../apps/service/README.md#会话执行工作树)和[Store](../../../../packages/agent/src/storage/README.md)。

## Alternatives considered

- 创建即切换或从消息／cd 推断：不是明确选择，并会让同轮并行操作获得不同根。
- 改共享 Workspace 或迁移 Session workspaceId：影响其他会话和父子／恢复身份，拒绝。
- 只允许空闲会话切换：不满足执行期间同轮使用需求。
- 切根时销毁旧 assembly：会关闭仍在运行的 Job；本轮保同 Run lease 到全部工作收口，不新建逐 epoch 引用计数。
- 升级工具或新增独立工具：用户明确保现有版本和工具；不用独立协议绕过这一决定。

## Consequences

新增根历史与私有候选只承担执行身份，不是第二份 Git 库存。目标真实身份或 epoch 变化失效原审批／Files 预读，最终 Store 控制读再次核验。只有明确成功回执可声称已切换；不自动清理旧目录或未知任务。删除占用还保留未终态 Job 的历史根。

同轮受控模型／真实 macOS Files 与 Shell、Store 故障与 Runtime lease 回归分别由相应 owner 维护；它们不授予 Native 窗口全过程、真实 Provider、Linux／Windows 或安装发行资格。
