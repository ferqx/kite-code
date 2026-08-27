# ADR-0145：Workspace Trust 绑定关联外部只读 Scope

状态：accepted

日期：2026-08-27

决策者：用户直接指令

相关：ADR-0131、ADR-0132、ADR-0135、ADR-0144、`docs/active/workspace-trust.md`、
`docs/active/execution-boundary.md`

## 背景

canonical Workspace 是完整授权身份，但Git linked worktree与external gitfile会把`.git`实际读取的
`gitDir/commondir`放在Workspace物理边界外。Local Runtime Service切换后，native sandbox只投影Workspace，
只读`git log`/`git branch`因此收到Git的误导性`not a git repository`。最初修复只自动接受标准registered
worktree，并继续拒绝其他外部repository；这仍把一个可由用户确认的外部只读scope错误地变成永久拒绝。

授权边界是Workspace关联scope，不是命令名。把`git log`加入命令allowlist或在Shell classifier中识别Git
只能覆盖个别语法，其他读取同一外部identity的进程仍会产生不同结果，也会让数据源或command spelling影响权限。

## 决策

1. Workspace Trust identity由canonical Workspace三元组与Workspace关联的external-read scope共同组成。当前
   discovery解析Git实际读取的canonical `gitDir/commondir`；后续其他Workspace关联只读root必须加入同一通用
   scope，不得创建命令专用授权旁路。pre-trust identity file读取上限为4 KiB且拒绝metadata-file symlink；不得在
   用户确认前读取repository config、objects、refs或正文。
2. scope discovery只返回排序、去重、最小化后的canonical roots及digest，不授予filesystem权限。App Control
   Trust query在Runtime transport建立前通过browser-safe exact DTO投影roots与digest，TUI必须逐项显示路径。
3. Trust decision同时绑定observed status、revision、完整Workspace identity与external-read scope digest。conflict
   或lost response只query authoritative state，不自动重放mutation。
4. 未确认、decline、store fault或scope identity drift时，Runtime connection保持关闭，native sandbox获得零
   Workspace-derived external root。不得让下游Git/工具错误替代authorization-required语义。
5. 用户确认后，macOS Seatbelt只增加exact `file-read` root，Linux bubblewrap只增加exact `--ro-bind`；不授权
   primary working tree、external metadata write、network、Full filesystem或Git transaction。每次sandbox preparation
   重新读取trusted scope，缓存executor不能保留已经漂移或撤销的root。
6. legacy trust record缺少scope digest时，只在当前external roots为空时继续有效；新增、移除或改变外部root均使
   status回到`unknown`并要求新的显式决定。
7. typed Git broker的repository hostile、standard worktree namespace、reciprocal backlink、symlink/alternates与
   transaction校验保持独立。其严格资格不能用来永久拒绝用户可确认的generic read-only scope，也不能因Trust批准
   而自动获得write/transaction authority。
8. 本策略不读取或分类具体Shell命令。危险命令、external mutation、Full/Auto/Accept Edits与工具级approval继续由
   既有Policy处理；Workspace Trust只回答“该Workspace是否可以读取这些关联外部roots”。

## 替代关系

- 扩展ADR-0131的完整Workspace身份，使物理位于Workspace外但逻辑关联的只读root具有显式授权表达。
- 细化ADR-0132/0135：此类稳定Workspace关联scope在Runtime连接前一次确认，不通过命令级external-path grammar
  重复询问；mutation与任意invocation外部scope规则不变。
- 扩展ADR-0144的App Workspace admission：trusted不仅要求canonical Workspace记录，还要求current external-read
  scope digest匹配。

## 后果

- linked worktree首次在新Service中打开时会显示primary `.git` canonical path；默认焦点仍为退出。确认后只读Git
  能正常读取objects/refs，换用其他只读命令或数据源不会改变这项授权。
- 非标准但真实存在的external gitfile也进入同一确认流程，不再被伪装成repository损坏；真实缺失或无法解析的
  metadata仍可报告repository invalid。
- App Contract Workspace Trust response/decision升级到v2，根contract revision升级为`kite-app-contract-v2`。

## 回滚

回滚必须由新的追加ADR说明为何Workspace关联外部root应恢复永久拒绝或命令级授权，并同步Trust DTO/store、
Service admission、TUI、native profile、三平台测试与active authority；不得只删除提示而保留隐式sandbox grant。
