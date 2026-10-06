# Agent Note: Native background overview keeps original authority outside the selected conversation

Status: implemented

## Problem

正式 Native 原先只从当前选中会话的有限 `getView` 显示执行。长会话当前投影修复保留了当前工作，但仍不能证明跨会话 Job／task／child 的完整集合；把每个有限视图拼成目录会遗漏历史载体，也会把后来 child Run 或当前选择误当原任务。已有完整已保存 Job 输出 reader 又只绑定原选中 Session，不能直接成为非选中后台控制 authority。

## Decision

当前同原 Store 的完整后台观察沿 Store／Runtime／HTTP／Client 公共目录提供。短只读事务先核 root creator、原 source Command 主体和实际 ancestry／Workspace／删除状态，再按原 Execution rowid 固定上界与最多200项分页。同一 change cursor 漂移使完整扫描丢弃前缀重读，没有累计页数截断。公开有限 metadata 保留原 parent Run、准确 child-start Run、取消与 delivery，私有执行正文及配置不进入目录。

Native Main 从已准入连接固定 generation／Store／subject，完整读取后登记原身份 observation；renderer 只能指定已观察 Execution，不能传 Session、Workspace、路径、游标或执行 authority。观察独立于当前选择；新目录 refresh 使旧停止资格失效，已固定原对象的输出与子日志读取仍按各自完整上界收束。完整保存输出复用原固定 H 公共覆盖，子日志固定原子会话消息上界并读取完整 ModelOutput，64KiB传输核 EOF／SHA／fatal UTF-8。父 Run、原 child Run 和日志中后来轮次保持各自身份。

准确 stop 先 fresh 核原身份、活动状态、attempt／owner generation／result revision，再复用既有 durable caller。内部后台 prepare 只为准确 `execution.cancel` 核根、原主体来源和实际后代 Session／Workspace；普通选中根 caller 门禁保持。既有或冷原意图仍只有原 GET，无新取消 journal 或第二套业务效果引擎。close/reset 只释放所属 GET，不取消、恢复或重发任务。

## Alternatives considered

- 穷举根 Session 后拼接有限 `getView`：当前投影只保证最近与未收束工作，不能提供全部原 Job、固定完整水位或准确原 child Run，因此未采用。
- 放宽普通 renderer caller 的 Session 输入：这会让 renderer 指定非选中后代并扩大已有 authority。实际采用 Main 完整公开观察和内部准确取消 prepare，普通根门禁保留。
- 另建后台停止 journal 或恢复旧 JobHandle：原完整 caller 已有 durable intent／热首次 POST／冷 GET 合同；复制会制造另一效果权威，旧 handle 不适合冷读取，因此未采用。
- 以最新 child Run 展示原 task 或只展示 Model preview：会改变原载体身份并截断完整日志。实际按准确 child-start 来源和完整公共 ModelOutput 展示。

## Consequences

正式总览可跨选择显示完整同原 Store 的后台工作，读取失败保留上次完整事实并冻结停止。Main 保留完整目录和详情，需要相应实际内存；持续变化可能使 snapshot 扫描继续等待，用户关闭只释放读取。业务终态仍由 Core／Service决定，accepted stop 不等于实际停止。

原 Store 身份与恢复后的准入 Store 分开。当前目录及详情只取得同原 Store 资格，恢复为新 Store 的旧来源条目仍待兼容迁移，不据此改变产品历史承诺或授予恢复／重执行许可。默认可信普通 Shell、四 Auth 人工证书、其他平台和全 V1.3 退出独立保持未完成。

当前合同归[Desktop owner](../../../../apps/desktop/README.md#native-跨会话后台总览)、[Store](../../../../packages/agent/src/storage/README.md#跨会话原-job-目录)、[Service](../../../../apps/service/README.md#完整后台执行目录)、[Client](../../../../packages/client/README.md#完整后台执行目录)与[active](../../../../docs/active/unified-agent-boundary.md)。必要实际验证、原失败和代码版本归[进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)，本决定不替代具体测试范围的资格。
