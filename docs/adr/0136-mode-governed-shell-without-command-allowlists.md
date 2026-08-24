# ADR-0136：Shell 授权不使用命令白名单

状态：accepted

日期：2026-08-24

决策者：用户直接指令

相关：ADR-0133、ADR-0134、ADR-0135、`docs/active/authorization.md`、
`docs/active/tool-gated-autonomy.md`

## 背景

Shell command surface 无法穷举。ADR-0134/0135 为 `git status`、`git log`、已知 local Git builtin 和少量
文件 mutation 建立了固定 grammar，并把命中 grammar 当作无需审批的正向授权。这会使同等作用的命令仅因程序名、
wrapper、alias 或参数形态不同而获得不同权限，也要求 Policy 持续追赶无限的 Shell 语法。

Workspace CWD 本身不能证明任意进程只访问 Workspace；字符串解析同样不能证明脚本、解释器或 child process 的完整
effects。因此局部命令白名单不应成为授权来源。

## 决策

1. Building 阶段的每个 `shell_execute` invocation 都编译为可审查的 `ask`，不再因命令名、Git subcommand、
   read-only grammar 或静态 Workspace target 推导直接 `allow`。Policy 使用 `risk=unknown` 与 `ask` 表明字符串
   分类不是授权证据；`uncertainEffects` 只在 effects 确实无法证明时设置，不能为了触发审批而扩大 sandbox scope。
2. Shell 按 interaction mode 统一治理：Accept Edits 请求用户批准 exact invocation；Auto 先由模型 reviewer
   批准、拒绝或升级用户；Full 对允许 bypass 的 Shell 直接授权。用户显式签发的 same-command grant 仍可复用 exact
   command，但不由固定 grammar 自动产生。
3. Planning 不执行任何 Shell。空命令和明确针对关键系统 identity 的递归删除或 destructive Git 继续 hard deny，
   reviewer、用户批准和 Full 都不能覆盖这些边界。
4. `isReadOnlyShellCommand` 等分类器可以继续用于只读 Subagent role ceiling、scheduler metadata、批准后的 hardened
   execution environment，以及依据已编译 effects 选择最小 filesystem/network sandbox scope；但其结果不得改变
   Policy decision、跳过 interaction-mode review 或生成授权。一次批准本身也不得把未声明的 network/external
   scope 自动扩大为 `allow_all`。
5. `read_file`、`search_content`、`search_files`、`write_file`、`edit_file` 与 typed `git_inspect` 是结构化 capability，
   继续按自身 schema、path scope 和 effects contract 治理；本决定只移除 raw Shell 的固定免审命令集合。

## 替代关系

- 替代 ADR-0134 决策 1、2 与后果中 direct `git status`/`git log` 无审批执行的结论；保留批准后 hardened
  environment 与 typed `git_inspect` 独立 qualification。
- 替代 ADR-0135 决策 1、3、4 及后果中闭集 Shell mutation、Workspace local Git 直接执行的结论；文件工具的
  Workspace 边界和三模式外部文件授权保持不变。

## 后果

- `ls`、`cat`、`rg`、`git status`、`git commit`、`touch`、`bun test`、解释器和未知脚本在授权层完全同路。
- Auto 成为普通 Shell 的默认低打扰入口；模型无法确认时升级用户。Accept Edits 不再有隐式 Shell fast path，
  Full 仍保持完整权限语义。
- 新增 Shell 程序或 Git subcommand 不需要修改授权白名单；只需在确有执行硬化、展示或 role ceiling 价值时扩展
  非授权分类器。

## 回滚

若要重新引入 Shell 命令级免审，必须追加 ADR 说明为何结构化 capability 或 mode review 不足，并证明该 grammar 对
wrapper、脚本、child process、环境、路径与跨平台语义是完整授权证据；不得只增加一个程序名集合。
