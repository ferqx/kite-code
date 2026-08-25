# ADR-0135：按 Workspace 边界统一交互模式授权

状态：accepted

日期：2026-08-24

决策者：用户直接指令

相关：ADR-0118、ADR-0131、ADR-0133、ADR-0134、`docs/active/authorization.md`、
`docs/active/tool-gated-autonomy.md`、`docs/active/execution-boundary.md`

## 背景

当前 native sandbox 已把 canonical Workspace 作为完整信任根，但 Policy 仍按工具名和少量命令闭集分别处理
Workspace mutation：文件工具在 `accept_edits` 可直接写入，而通用 Shell mutation 与 ADR-0134 闭集外 Git
仍可能请求审批。结果是同一个 Workspace 内的 `touch`、`git add`、`git commit` 与文件编辑出现不同授权结果，
并且 `git status --short`、`git log --oneline -10` 的修复没有覆盖其他可证明的 Workspace 操作。

用户指定的交互边界是 Workspace scope，而不是 Git 特例：Building 阶段内，可证明只作用于当前 Workspace 的
操作应直接执行；Workspace 外、远端或目标无法证明的操作才按 Accept Edits、Auto、Full 分流。Plan 的只读
phase constraint 与关键系统破坏性 hard deny 是独立边界。

## 决策

1. Building 阶段的文件 mutation、闭集可证明目标的 Shell mutation，以及 direct Git local operation，只要
   所有已知目标均位于 canonical Workspace，就由 Policy 直接 `allow`，不依赖 `same_command`、Full grant 或
   Auto reviewer。Workspace 内 `.git`、隐藏目录和 credential-looking 名称不缩小该 scope。
2. Workspace 外、Git remote/network、外部 executable identity 或无法证明目标的脚本继续编译为 `ask`：
   - Accept Edits 请求真人 exact invocation approval；
   - Auto 请求模型三态审查，模型返回 escalate、无效响应、异常或 circuit breaker 时转真人审批；
   - Full 使用 `fullAccessMayBypassApproval` 直接授权。
3. Shell workspace fast path 只接受可证明的 direct command/target grammar。变量、command substitution、复合
   Shell、任意脚本、未知 executable、外部读取源或无法静态确定的路径不得伪装成 Workspace-only。批准后仍以
   sealed `allow_all` 单次执行，native sandbox 不得再次按 protected name 拒绝。
   这些 grammar 只是免审 proof，不是完整命令枚举：未知或未覆盖命令必须编译为可审查的 `ask`，不得因不在
   固定列表 hard deny。在 Auto 中，所有此类 `ask` 必须先进入模型 reviewer；只有 reviewer 主动升级、响应
   无效/异常或 circuit breaker 时才请求用户。
4. direct Git scope classifier 接受受信 Git executable、已知 local builtin、Workspace 内 `-C`、`--git-dir`、
   `--work-tree`、path operand 与 output/config path。remote/network subcommand、Workspace 外 path、未知 alias/
   helper、任意 `-c`/`--config-env` 或未知 subcommand 进入模式审查。`git status`/`git log` 仍可使用
   ADR-0134 的 hardened policy-proven-read-only environment；其他 Workspace Git 不因此冒充 typed
   `git_inspect` production qualification。
5. Planning mutation 继续 hard deny。明确递归删除 `/`、`/etc`、`/boot`、`/bin`、`/sbin`、`/lib*`、
   `/sys`、`/proc`、`/dev`、Windows system roots 等关键系统 identity 继续 hard deny；普通 Workspace 外
   credential/system access 与非关键 destructive target 不得仅因路径名称永久拒绝，而是遵循上述模式矩阵。
6. 新配置与新 TUI 会话默认 interaction mode 为 Auto，使待审查 Shell 先进入模型 reviewer。用户显式配置或
   `/permissions` 选择的 Accept Edits/Full 保持权威；Runtime 内部调用遗漏显式 mode 时仍 fail-safe 回退
   Accept Edits，不得用产品默认值伪造 inherited authorization。

## 替代关系

- 扩展 ADR-0118/ADR-0131 的 trusted Workspace 结论，使 Policy authorization 与 native sandbox 使用同一完整
  Workspace identity。
- 替代 ADR-0134 决策 1、2 和后果中“只有 `git status`/`git log` 闭集免审批、其他 Workspace Git 不获得
  免审批 authority”的限制；保留其 hardened read environment、raw Git token 不 hard deny、typed
  `git_inspect` 独立 qualification 结论。
- 细化 ADR-0133：Full/Auto/其他模式分流适用于所有 Workspace 外或无法证明目标的 filesystem/Shell/Git
  operation，而不是只适用于 sensitive external identity。

## 后果

- `git status --short`、`git log --oneline -10`、`git diff`、`git add`、`git commit`、Workspace 内
  `touch`/`mkdir`/重定向写入/删除以及内建文件编辑在 Building 阶段均不弹审批。
- `git push`、外部 repo/worktree、`cp` 的外部源、外部写入和任意目标脚本在 Full 直通、Auto 模型审查、
  Accept Edits 真人审批；Auto 无法确认时升级用户。
- scope classifier 必须保持保守。新增可直通 grammar 时需要同时覆盖外部读取、外部写入、变量、wrapper、
  remote 与 hostile executable 的负向测试。
- Auto 是广泛 Shell command surface 的优先交互路径：Policy 描述权限/effects，模型 reviewer 处理固定 grammar
  无法穷举的命令意图；reviewer 不能反向把关键系统 hard deny 或 Plan phase deny 改成可执行。
- 新会话默认 Auto；现有显式配置、持久化 session mode 与运行中 `/permissions` 选择不被迁移或覆盖。

## 回滚

回滚必须由新的追加 ADR 说明为何 Policy authorization 与 canonical Workspace native scope 必须重新分裂，并同步
Shell/Git classifier、文件工具策略、三模式测试与 active 文档；不得恢复 Git token 或隐藏名称级 hard deny。
