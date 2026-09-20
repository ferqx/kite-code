# Git 交付作用域

先检查 staged、unstaged、untracked 和唯一 Git owner，保护无关改动。

- `stage` 核对本次要暂存的完整改动。
- `commit` 核对 staged 内容。
- `push` 和 `pull_request` 核对已提交变更的实际 range，不用空暂存区代替。

push 前核实 remote、目标 ref、待推送 head 和远端 tip；PR 核实目标分支和 head，不猜默认分支。常规 fast-forward push 的 range 使用已核实远端 tip 与 `HEAD` 的 merge-base 差异；PR 使用目标分支与 `HEAD` 的 merge-base 差异。新远端分支需确定交付基线。

非 fast-forward、推送非 `HEAD` 或多个 ref 时，按实际 commit 集合逐一核对。基线或目标无法核实时阻塞该 Git action，不扩大 Git 授权。

进入新提交边界时重新核对该边界。然后读 [validation.md](validation.md) 选择与当前 range 匹配的检查。
