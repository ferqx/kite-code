# ADR-0134：Workspace Shell 允许闭集只读 Git 检查

状态：accepted

日期：2026-08-24

决策者：用户直接指令

相关：ADR-0097、ADR-0131、`docs/active/tool-gated-autonomy.md`、
`docs/active/execution-boundary.md`

## 背景

ADR-0131 已把 canonical Workspace 作为完整 sandbox identity，并取消 `.git` 名称级 native deny；但
ADR-0097 遗留的 Shell Git capability routing 仍在 Policy 层对任何 `git` executable token 做 hard deny。
因此 `git status --short`、`git log --oneline -10` 即使只读取 Workspace metadata，也在 native sandbox
启动前失败。这与 Workspace 内不按隐藏目录或 `.git` 名称限制的当前规则冲突，而当前 typed `git_inspect`
production qualification 又是 excluded，导致调用没有可用的替代路径。

## 决策

1. 直接 Shell 命令的闭集 grammar 将 `git status` 与不产生 patch 的 `git log` 识别为
   `policy_proven_read_only`。至少支持 `git status --short` 与 `git log --oneline -10`，并只接受明确列出的
   status/log 参数形态。
2. 该 fast path 只接受 direct `git` executable。绝对路径、nested shell、间接 interpreter、未知 Git
   subcommand、`diff/show/ls-files`、产生 patch 的 log 参数和 mutation/remote command 不进入只读闭集，按
   ordinary Shell effects 进入 Full 直接授权、Auto 三态审查、普通模式 exact approval、Planning/hard-deny 与
   network 规则；不得仅因 executable 名为 Git 返回不可批准错误。
3. policy-proven Git read 使用 Workspace-excluded PATH 和非登录 Shell，并固定关闭 system/global config、
   credential prompt、pager、external diff、optional locks 与 repository `core.fsmonitor` helper。POSIX 与
   Windows preparation 必须投影同一环境 ceiling。
4. 删除 `brokered-git-r1` 对 raw Shell Git executable token 的 hard deny 与
   `nextCapability=git_inspect` recovery。typed `git_inspect` 仍是独立结构化 capability；其 schema、hostile
   repository 检查、surface disclosure 与 production qualification 不因本决定扩大，也不覆盖普通 Shell 的
   mode-aware authorization。

## 替代关系

- 替代 ADR-0097 决策 1、10 与回滚段中“所有通用 Shell Git 必须拒绝、只读检查也不能恢复”的绝对结论。
- 替代 ADR-0131 决策 7 中保留 Shell `git` capability routing 的部分；其余 Workspace identity、typed
  broker qualification 与生产支持集结论保持不变。

## 后果

- `git status --short`、`git log --oneline -10` 可在 Workspace sandbox 内无审批执行，不再出现
  `nextCapability=git_inspect` 错误。
- 闭集外 Git 不获得只读或免审批 authority，但可以按照 Full、Auto 或 exact user approval 的普通模式治理
  执行；network、Planning 与 hard deny 仍独立生效。

## 回滚

回滚必须由新的追加 ADR 说明 Workspace 内只读 Git 为何必须重新 hard deny，并同步 Policy grammar、两平台
只读环境、native integration、active 文档与模式测试；不得只恢复 token 级拒绝。
