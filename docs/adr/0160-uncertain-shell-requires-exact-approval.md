# ADR-0160：无法证明副作用的 Shell 必须请求 exact 用户审批

状态：accepted

日期：2026-09-01

决策者：用户直接指令

相关：ADR-0097、ADR-0134、ADR-0136、ADR-0137、`docs/active/authorization.md`、
`docs/active/tool-gated-autonomy.md`

## 背景

ADR-0137 允许 Building 的 Workspace read/write baseline 与 Planning 的 read-only baseline 内未知 Shell 直接进入
Sandbox，只对已知扩 scope 请求审批。实际实现同时用保守的只读 grammar、整段命令正则与风险标签推断效果，导致
`git log --format=...` 中作为参数出现的 `format` 被误识别为 Windows 磁盘格式化程序，并由
`risk=destructive` 直接产生 `tool.rejected`，没有 `approval.requested`。这证明“无法证明只读”、风险提示与不可覆盖
hard deny 没有被结构化区分。

产品同时要求模型发出的 Git、构建、测试、package-manager、project script 与其他脚本命令统一经过
`shell_execute`；typed Git broker可以继续作为Runtime内部机制，但不能构成第二个模型命令入口。

## 决策

1. Shell Policy区分`proven_read_only`、已知effects、`uncertainEffects`与明确hard deny。没有通过只读grammar且无法
   完整确定effects的调用必须编译为`decision=ask + requiresApproval=true`，在Accept Edits、Auto与Full中都请求
   exact用户审批；Auto reviewer不得替代这次真人确认。
2. 用户审批只绑定exact invocation、command digest、Session/Workspace与sealed sandbox scope。批准未知命令不自动
   取得网络、Workspace外文件或Full authority；Sandbox继续兑现编译范围。
3. 只有Policy Compiler明确产生`allowed=false`的关键系统删除、提权/边界缺失等规则是不可覆盖hard deny。风险标签与
   `uncertainEffects`不能单独生成deny。
4. 危险程序名只在Shell segment的可执行位置匹配；参数、quoted text与普通输出中的`format`、`diskpart`等词不能提升
   风险。解析无法建立高置信命令位置时回到`uncertainEffects`审批，不伪造destructive事实。
5. `git_inspect`从model-visible catalog移为internal Runtime capability。所有模型发出的Git命令与其他脚本命令统一走
   `shell_execute`；内部broker代码可以继续服务非模型Runtime机制，不能被模型ToolSet或tool search披露。
6. `tool.rejected`在Public History保留独立`rejected`状态和稳定`reason_code`/脱敏摘要，不再折叠为`failed`。TUI保留
   未started的策略拒绝诊断；Web不显示exit code或`No output`，因为该调用从未dispatch。

## 与旧决策的关系

- 部分supersede ADR-0137的“未知baseline Shell直接执行”与Auto reviewer路由；已证明只读、已知scope expansion、
  durable approval queue、same-command identity、sandbox与recovery结论继续有效。
- 部分supersede ADR-0097/0134中model-visible typed `git_inspect`结论；broker的内部repository hardening与Provider机制保留。
- 保留ADR-0136“不能按命令名白名单hard deny”的结论，并进一步规定静态不确定必须进入exact用户审批。

## 后果

- 未识别脚本比此前多一次人工确认，但不再因为分类器缺项或参数文本产生无提示拒绝。
- Shell仍是模型脚本的唯一治理入口，approval、Sandbox、receipt与TUI/Web展示共享同一调用身份。
- 只读grammar继续用于免审、调度、Subagent ceiling与hardened environment；它不需要也不应穷举所有程序。
- Public Browser可以区分执行失败与执行前拒绝，同时不获得raw Runtime reason、路径或命令正文。

## 回滚

回滚必须新增ADR，并同时恢复模型工具面、Policy矩阵、Kernel approval route、Agent API状态与TUI/Web投影。不得只把
`uncertainEffects`改回allow、只恢复`rejected→failed`映射，或通过扩大危险命令正则代替结构化决策。
