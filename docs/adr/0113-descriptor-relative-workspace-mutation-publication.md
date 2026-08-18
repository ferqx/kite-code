# ADR-0113：Workspace mutation 使用 descriptor-relative 发布

状态：accepted

日期：2026-08-17

决策者：github:@ferqx

相关：ADR-0042、ADR-0065、ADR-0100、ADR-0105、ADR-0110、ADR-0111、`docs/space/plans/2026-08-16-trustworthy-runtime-convergence.md`

## 背景

ADR-0111 把 Workspace filesystem I/O 收敛到 sealed grant 与 Local Provider，但仅在最终 `rename` 前重验
parent identity 仍存在检查到使用的窗口。攻击者可在最后一次 `lstat`/`fstat` 比较返回后，把 lexical parent
替换为指向 Workspace 外的 symlink；随后按绝对路径执行的 `rename(temp, target)` 会重新解析该 parent，因而
可能把已批准的 `workspace_only` 写入重定向到 Workspace 外。

对最终路径增加 post-check 不能修复该问题：rename 已经产生副作用，且外部目标可能已被覆盖。保留 path-based
rename 作为平台 fallback 同样会使 Provider seam 在最需要 fail closed 时失去边界。

## 决策

1. Local Workspace filesystem mutation 从临时文件创建到最终发布都必须消费已经验证并 pin 的 parent directory
   descriptor。Unix 后端使用 libc `openat`/`mkdirat`/`unlinkat`/`renameat`；传入 native 调用的名称必须是经过
   校验的单个 basename，不能包含 separator、`.`、`..` 或 NUL。
2. 尚不存在的 parent chain 从 prepare 固定的 nearest-existing ancestor descriptor 开始逐段创建并用
   `O_DIRECTORY | O_NOFOLLOW` 重新打开；不得用 path-based recursive mkdir 创建 mutation parent。失败清理只使用
   保留的 ancestor descriptors 与 `unlinkat`，不能重新按 lexical path 寻址。
3. 最后一次 lexical identity 重验之后，发布仍只使用 pinned parent descriptor。若 hostile rename/symlink swap
   恰好发生在重验与 `renameat` 之间，它不能把写入重定向到 Workspace 外；Provider 随后的 terminal evidence
   无法证明 lexical target 时按既有 contract 收敛为 commit-unknown，不得自动重放。
4. Windows 当前 Bun/Node filesystem API 不提供 descriptor-relative create/rename，现有 path-based API 也不能
   证明 junction/reparse-point race 安全。因此 Windows Local Provider mutation 在任何临时文件、目录或目标写入前
   返回 fail-closed；read/search observation 不受影响。后续只有经独立 ADR、native implementation 与 race
   conformance 验收的 Windows handle-relative backend 才能恢复 mutation，不能回退 `renameSync`。
5. 确定性 race 测试可以在 test environment 的内部 final-check→publish hook 交换 parent；该 hook 不进入 protocol、
   Provider options、production export 或 runtime composition，并且非 test environment 永不读取或调用它。
6. 本决策不改变 Runtime schema 或 format epoch。它只收紧 Local Provider 对既有 commit grant 的物理兑现。

## 备选方案

- final check 后继续使用绝对路径 `renameSync`：拒绝。路径会重新解析 parent，检查结果没有被实际发布消费。
- rename 后再次验证并在失败时删除外部目标：拒绝。外部数据已可能被覆盖，补偿既不安全也不能恢复原内容。
- 用 `/proc/self/fd/<n>/name` 或 `/dev/fd/<n>/name` 拼路径：拒绝。macOS 不支持目录 descriptor 下的这种路径解析，
  且字符串化 descriptor 不是跨平台 native contract。
- Windows 暂时保留旧路径实现：拒绝。Provider 失败不得恢复不受同一安全不变量约束的 runtime fallback。

## 后果

- Unix Local Provider mutation 由 Bun FFI 直接链接系统 `openat`/`mkdirat`/`unlinkat`/`renameat`；macOS 使用
  libSystem 的固定四参数 `__openat` syscall stub，避免 variadic `openat` 的 mode ABI 漂移。Unix 临时文件在
  写入正文前还必须按既有 target mode（新文件为 `0644`）执行 descriptor `fchmod`。symbol/load 失败、native 调用失败或平台不受
  支持都必须 fail closed，不能改走 path API；standalone packaging 不依赖运行时 C source resource。
- Windows 仍可运行普通 TUI/CLI 和 read/search filesystem capability，但 write/edit 暂不可用；这与
  ADR-0065 的“发行目标不等于 effectful capability 已准入”一致。
- final-check 后发生的 namespace swap 可能把原子发布留在已 pin、随后被移走的 Workspace directory 中，并使
  terminal evidence 成为 unknown；它不会跨到攻击者替换后的外部目录，也不得被分类为已知可重试失败。

## 回滚

回滚只能撤销尚未合并的 PS-01 seam migration。不能恢复 path-based rename、recursive mkdir 或 cleanup fallback。
若 native descriptor-relative backend 不可用，mutation 必须保持 fail closed。
