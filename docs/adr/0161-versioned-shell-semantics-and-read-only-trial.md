# ADR-0161：Shell 语义注册表与严格只读一次性试跑

状态：accepted

日期：2026-09-01

决策者：用户直接指令

相关：ADR-0054、ADR-0134、ADR-0136、ADR-0160、`docs/active/authorization.md`、
`docs/active/tool-gated-autonomy.md`

## 背景

ADR-0160要求无法证明effects的Shell进入exact真人审批，但只读证明仍集中在大型条件函数中。项目探索经常组合
`ls/git status/git branch -a/git remote -v/head/echo`，其中任一未覆盖shape都会让整条命令降级。继续追加散落
特例难以审计，也没有把语义变化绑定进`shell_execute` capability revision。

直接把未知命令当作只读同样不可接受：程序名不能证明参数语义，Workspace只读也不能自动授予网络或外部路径。
用户需要一个比正常`approve_once`更窄的选择，在不扩大authority的前提下尝试运行无法静态证明的命令。

## 决策

1. Builtin Runtime拥有唯一冻结、版本化的`ShellSemanticsRegistry`。program映射、Git列表shape与mutation subcommand
   以声明式descriptor表达；参数敏感程序继续由注册表指向局部inspector。未注册程序和未命中shape均保持unknown。
2. registry内容digest进入`shell_execute` capability revision。语义变化会改变binding identity，使旧prepared
   invocation在新Service中fail closed；TUI、Service或Sandbox不得维护第二份命令白名单。
3. `uncertainEffects` Shell的真人审批新增`read_only_once` grant，并作为推荐选项。该grant绑定原exact invocation、
   approval digest与generation，但执行时进一步收紧为Workspace只读、network disabled、Workspace-only filesystem；
   它不能创建same-command grant，也不能复用于其他调用。
4. Kernel只在`executionMechanism=shell + uncertainEffects=true`时接受`read_only_once`。其他工具、已知effect或伪造
   approval即使identity匹配也以`authorization_elevation_denied`拒绝。
5. `approve_once`与`same_command`继续表示原sealed policy scope。只读试跑因写入被Sandbox拒绝后不会自动升级；模型可
   重新提出exact调用，用户再选择正常单次批准。
6. 未证明原因只投影低基数本地诊断：`unregistered_program`、`unsupported_invocation`、`output_redirect`、
   `dynamic_expansion`、`background_execution`或`empty_or_multiline`。原始command仍只留在既有本地Runtime日志；
   不新增遥测、持久表或自动学习授权。

## 后果

- 增加常见只读命令通常只需扩展descriptor；参数可写的程序仍需专用inspector和正反测试。
- 未知脚本保留正常审批能力，同时用户可先选择严格只读试跑。
- Protocol与durable State新增一个closed grant值，live、resume与history保持同一审批身份。
- registry不是通用Shell parser，也不会从一次用户批准学习永久规则。

## 回滚

回滚必须新增ADR，并同时处理registry-bound capability revision、Protocol grant、Kernel receipt/replay、Service Sandbox
收窄与TUI选项。不得只删除UI选项而继续接受grant，也不得只放宽classifier替代unknown审批。
