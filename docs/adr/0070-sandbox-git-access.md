# ADR-0070：seatbelt 沙箱放行 git 命令对 Workspace `.git` 的访问

状态：accepted
日期：2026-08-07
决策者：`@chenchao`
关联：ADR-0054、ADR-0042、`docs/active/execution-boundary.md`

## 背景

TUI 默认开启 seatbelt sandbox（`config.sandbox.enabled` 默认 `true`，shell 经
`composeAppSandboxExecutorV1` 走 `sandbox-exec`）。在该沙箱内执行任何 `git` 命令都失败：

- profile 以 `(deny default)` 只放行少量系统读取根，`/var/select/` 下只放行了
  `/private/var/select/sh`，漏掉了 `/private/var/select/developer_dir`。Apple 的
  `/usr/bin/git` 是 118KB shim，经 `xcode-select`/`xcrun` 读取该符号链接定位
  `/Library/Developer/CommandLineTools/usr/bin/git`；readlink 被拒后报出误导性的
  `xcode-select: error: unable to read data link at '/var/select/developer_dir', expected
  symbolic link`。clang、make 等 CLT shim 同样受影响；
- 即使放行该符号链接，git 继续读取 `~/.gitconfig`（HOME 真实、家目录不在读取根）与
  Workspace `.git/`（protected path）时仍被拒，`git diff --stat` 等无法在 sandbox shell 使用。

Linux bubblewrap 绑定完整 Workspace（含 `.git`），git 本就可用；macOS Seatbelt 因受保护路径
deny 反而不可用，两平台行为不一致。

## 决策

1. `/private/var/select/developer_dir` 无条件加入 `SYSTEM_READ_FILES`：CLT shim 可解析真实
   二进制，消除误导性 xcode-select 错误。这是对所有 CLT 工具（git、clang、make、xcrun）的
   纯读取放行，不扩大可写面。
2. `generateSandboxProfile` 新增 `gitAccess: 'deny' | 'allow'`，默认 `'deny'`；seatbelt
   executor 显式传入 `'allow'`。`'allow'` 时：
   - 放行存在的用户 git config（`~/.gitconfig`、`$XDG_CONFIG_HOME/git/config`）读取；
   - 把 Workspace `.git` 目录从原生 protected-path deny（读与写）中豁免，git 命令可操作仓库。
3. 直接 `.git` 访问不放行：`.git` 仍保留在 `PROTECTED_WORKSPACE_DIRECTORIES_V1`，模型文件工具
   的 protected-path evaluator 继续返回 deny；`checkDangerousPaths()` 的 `.git/config`、
   `.git/hooks/`、`.gitmodules`、`.git-credentials` 等命令文本扫描继续拒绝裸 shell 直读。
   `.git-credentials`、`.gitmodules` 等 protected file 保持 deny。
4. 行为与 Linux bubblewrap 对齐：macOS Seatbelt 与 bwrap 都允许 git 命令访问 `.git`，直接
   `.git` 访问仍受工具层与命令文本层约束。

## 备选方案

- typed 模型 git 工具（仿 worktree-controller）：改动面大，需新增工具 schema、capability 与
  审批流，当前模型没有可用 git 工具，git-in-shell 是既有交互路径；
- git 命令绕过 sandbox（检测前缀不经 sandbox-exec）：弱化沙箱隔离且前缀检测易被混淆绕过；
- 维持 deny 并要求用户改用 typed controller：模型无可用 git 工具，`git diff --stat` 等仍以
  误导性 xcode-select 错误失败。

## 后果

- `git diff --stat`、`git status`、`git log` 等只读/常规命令可在 sandbox shell 正常执行；
- seatbelt 的 OS 边界不再隔离 `.git`；shell 间接路径（如
  `cat "$(git rev-parse --git-dir)/config"`）理论上可读 `.git` 内容。剩余控制为 tool-policy
  evaluator（文件工具）与 `checkDangerousPaths()`（命令文本），均属 best-effort 文本/策略层，
  不再是原生边界。该取舍是「git 可用」的必要代价；
- git 命令可能输出受保护 tracked 文件的 `Operation not permitted` 噪音（.agents/.vscode/.claude
  等仍在原生 deny），以及 `xcrun` 缓存写失败的噪音；均非致命，命令退出码为 0；
- macOS 与 Linux 沙箱行为一致，降低跨平台差异维护成本。

## 回滚

撤销 `profile.ts` 的 `SYSTEM_READ_FILES`/`gitAccess` 改动，或让 seatbelt executor 传
`gitAccess: 'deny'`，即可回到 `.git` 全量原生 deny 的旧行为，无需改动 `PROTECTED_*` 定义与
tool-policy 层。
