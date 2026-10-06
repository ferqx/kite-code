# Agent Note: Native 只读 Skill 目录与有限页交接

Status: implemented

## Problem

旧 Desktop 的 Skills 分类有名称、描述、来源和可用状态，迁移前正式 Native 缺少这一目录消费者。公共 Service 已提供可信配置目录和同 revision 分页；把完整集合塞入单次有限 IPC 会让传输预算限制完整目录，页面自行扫描文件又会复制可信来源规则。产品依据是[Desktop 手册](../../../../docs/handbook/clients/desktop/README.md)，当前实施范围见 [P5 方案](../../../../docs/plans/unified-agent-refactor-v1.md#3021-当前-native-skills-消费者迁移)。

## Decision

Main 封存实际 Session/Workspace/Store、attach generation、viewSelection 与 historyEpoch，使用独立 read ID 和有限 open/next/close 传输公共页。open 在任何 GET 前同步核对原选择并登记 lease，不排队在 controller refresh 后，避免关闭先发生后迟到 open 重新创建读取。Main 保存原目录 revision/cursor，renderer 复用公共闭合 verifier，穷尽原页后才发布完整集合。刷新失败保留同作用域的已知目录并明确未更新；切换、关闭和观察 reset 中止所属 GET，迟到值不改绑。单页 128 KiB 预算只限制传输，无总目录截断；普通 controller viewGeneration 更新不重开同一目录。

来源为已准入配置位置的有限分类，project/user 与 .agents/.kite-code/profile/configured 不携路径或执行权。禁用项不因此读取文件，拒绝的来源不能伪装为可信位置；旧 producer 省略新字段时说明未记录。目录仍是知识发现，不读取正文、安装或激活 Workflow，不选择模型或启动 Run。负责实现见 [Desktop](../../../../apps/desktop/README.md#native-skills-只读目录)、[Service](../../../../apps/service/README.md) 与 [Client](../../../../packages/client/README.md)。

## Alternatives considered

- Main 调用 listAllSkills 后用单个 IPC 返回全集：会以单响应预算限制完整目录，故逐页交接并保留同 revision。
- renderer 直接扫描 Skill 目录或接收路径：会复制 Service 的信任与发现规则，故只消费公开 DTO。
- 页面逐页立即显示为完整：后续失败或 revision 变化会把前缀误报为完整事实，故在全部读取成功后发布；已有成功事实在刷新失败时单独保留。
- 恢复旧 home 的隐式扫描：当前同源 Service 明确以可信配置装配知识，本次入口迁移不改变发现和执行范围；旧来源没有映射时不能补造旧路径或安装事实。


## Consequences

有限 IPC 可以完整交接大目录，但 renderer 需要保存当前读取的全部元数据，刷新只有穷尽同 revision 后才能更新完整事实。目录 revision 防止混页，不是与外部写者的文件系统事务或以后执行的版本预订。来源只说明配置位置，不证明安装或授权。当前默认发现范围、完整 Skill/Workflow 迁移、其他客户端与跨平台资格仍由对应 owner 和 V1.3 阶段核对，不能由此 Native 目录窗口推导全部完成。

## Verification and limits

公共 HTTP/Client、Main/IPC 和实际 DOM 有限验证通过；实际移动并删除构建源的默认 Native 窗口完整读取 306 项、16 个同 revision 页，文件与配置刷新、不可用/空目录、两 Workspace、分类关闭重开和冷启动通过。两所属 Service 普通退出；独立 post-exit public readonly Store 核零 Run/Execution 与读取水位不变。原完整默认 598 文件/475 任务 actual exit0，输入与 Git 前后保持；首次窗口 helper 的展开错误及全部原断言保留。准确命令、输入、原失败和环境范围见[当前进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07正式-native-只读-skills-目录与阶段收束)。这项决定已交付当前 Native 公开目录消费者，不授予完整 Skills/Workflow、默认 Shell、三平台或发行资格。
