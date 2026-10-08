# Agent Note: Native background overview keeps original authority outside the selected conversation

Status: implemented

## Problem

正式 Native 原先只从当前选中会话的有限 `getView` 显示执行。长会话当前投影修复保留了当前工作，但仍不能证明跨会话 Job／task／child 的完整集合；把每个有限视图拼成目录会遗漏历史载体，也会把后来 child Run 或当前选择误当原任务。已有完整已保存 Job 输出 reader 又只绑定原选中 Session，不能直接成为非选中后台控制 authority。

## Decision

完整后台观察沿 Store／Runtime／HTTP／Client 公共目录提供。当前 Store 用于准入和页面快照，每项原 originStoreId 保持；只在原 root creator 出处不同于当前 Store 的准确恢复根内读取旧来源。短只读事务先核 root creator、真实 source／root-work Command 的主体、出处和序号，以及 sealed child-start／carrier 与实际 ancestry／Workspace／删除状态，再按原 Execution rowid 固定上界与最多200项分页。多次恢复保留期间各 Store 的原工作，不要求原 Job 出处等于根最初创建出处。同一 change cursor 漂移使完整扫描丢弃前缀重读，没有累计页数截断。公开有限 metadata 保留原 parent Run、准确 child-start Run、取消与 delivery，私有执行正文及配置不进入目录。

Native Main 从已准入连接固定 generation／Store／subject，完整读取后登记原身份 observation；renderer 只能指定已观察 Execution，不能传 Session、Workspace、路径、游标或执行 authority。全局总览观察独立于当前选择；新目录 refresh 使旧停止资格失效，已固定原对象的输出与子日志读取仍按各自完整上界收束。完整保存输出复用原固定 H 公共覆盖，子日志固定原子会话消息上界并读取完整 ModelOutput，64KiB传输核 EOF／SHA／fatal UTF-8。父 Run、原 child Run 和日志中后来轮次保持各自身份。

准确 stop 先要求原 Execution 属于当前 Store，再 fresh 核原身份、活动状态、attempt／owner generation／result revision，再复用既有 durable caller。内部后台 prepare 只为准确 `execution.cancel` 核根、原主体来源和实际后代 Session／Workspace；普通选中根 caller 门禁保持。既有或冷原意图仍只有原 GET，无新取消 journal 或第二套业务效果引擎。close/reset 只释放所属 GET，不取消、恢复或重发任务。存储层取消在首写前核完整目标与 attached 扩展中的当前 Execution／Run／source，混有旧来源时整项拒绝；既有原 receipt 相同请求仍只返回原记录。原出处与当前准入的区分同时用于 Job 输出 lease 和子 Model 正文：ModelOutput snapshot 仍标当前 Store，originMessage 另与真实 Model 原 Session／Run／originStoreId 核对。

2026-10-08 原 PC 环境卡扩展复用上述 Main reader、完整公开目录、原取消 journal 和 child reader；原全局总览的独立选择合同保持。环境实例从实际选中根 snapshot 固定 root／viewSelection，renderer 仅给有限 surface，不能给根或路径；重选只释放环境范围，两个展示互不借用 observation。原 SessionPage 用相同完整 child 事实打开只读详情，保 Main 根和父草稿。SSE 只触发完整 GET，缓存只保有限展示 metadata，停止仍要求 fresh 原身份；observer reset 取消旧目录时，所有共用等待者收到明确失效，页面等待新观察。

## Alternatives considered

- 穷举根 Session 后拼接有限 `getView`：当前投影只保证最近与未收束工作，不能提供全部原 Job、固定完整水位或准确原 child Run，因此未采用。
- 放宽普通 renderer caller 的 Session 输入：这会让 renderer 指定非选中后代并扩大已有 authority。实际采用 Main 完整公开观察和内部准确取消 prepare，普通根门禁保留。
- 从零建立另一套 PC 环境卡或复制后台控制链：原卡、布局、完整 reader 与 durable caller 已覆盖展示及控制；采用原组件加 Main 当前根实例，避免新的 I/O 与效果权威。
- 让环境卡与全局总览共用同一个 observation：当前根切换须撤销环境资格，但全局仍可看原任务，两者生命周期冲突，因此复用类和原端口而各持实例。
- 另建后台停止 journal 或恢复旧 JobHandle：原完整 caller 已有 durable intent／热首次 POST／冷 GET 合同；复制会制造另一效果权威，旧 handle 不适合冷读取，因此未采用。
- 直接放宽所有 foreign-origin 或要求 Job 出处等于最初 root creator：前者缺少准确恢复根证明，后者会排除两次恢复之间真实新工作，因此采用准确恢复根加各项真实来源链。
- 只在 renderer 隐藏历史停止按钮：新当前 Store 取消请求仍可进入底层，必须在存储事务首写前拒绝旧来源效果，Main 和页面同时限制。
- 以最新 child Run 展示原 task 或只展示 Model preview：会改变原载体身份并截断完整日志。实际按准确 child-start 来源和完整公共 ModelOutput 展示。

## Consequences

正式总览可跨选择显示完整当前工作与准确恢复历史，读取失败保留上次完整事实并冻结停止。Main 保留完整目录和详情，需要相应实际内存；持续变化可能使 snapshot 扫描继续等待，用户关闭只释放读取。业务终态仍由 Core／Service决定，accepted stop 不等于实际停止。

恢复历史显示原 Store 与只读状态，旧来源不获得停止／恢复／重执行许可。期间新 Store 明确创建的工作可按准确当前目标停止；包含旧来源的整组取消被原子拒绝，不能部分修改历史。完整子日志沿子消息与完整 ModelOutput 读取，诊断 SessionLog 的 replayFloor 合同保持。这份后台恢复历史证据不扩大默认普通 Shell 或 Auth 的独立资格；当前资格沿 Desktop owner 的实际证据核对，其他平台和全 V1.3 退出保持未完成。

当前合同归[Desktop owner](../../../../apps/desktop/README.md#native-跨会话后台总览)、[Store](../../../../packages/agent/src/storage/README.md#跨会话原-job-目录)、[Service](../../../../apps/service/README.md#完整后台执行目录)、[Client](../../../../packages/client/README.md#完整后台执行目录)与[active](../../../../docs/active/unified-agent-boundary.md)。必要实际验证、原失败和代码版本归[进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)，本决定不替代具体测试范围的资格。
