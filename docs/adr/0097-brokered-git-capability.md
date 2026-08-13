# ADR-0097：Git 从通用 Shell 迁移到 App-owned typed capability

状态：accepted
日期：2026-08-09
决策者：github:@ferqx
取代：ADR-0070（历史正文保留）
关联：ADR-0043、ADR-0054、ADR-0061、ADR-0076、ADR-0077、ADR-0079、ADR-0080

## 背景

ADR-0070 为解决 macOS sandbox 中 Git 不可用，允许整个 shell descendant 访问 Workspace `.git`，并依赖命令文本扫描
区分 Git 与直接访问。已有 native test 证明混淆字面量可以绕过该文本层限制并读取 `.git/config`。Linux bubblewrap 绑定
完整 Workspace，也没有 OS 级 `.git` 区分；Windows restricted-token backend 则把 `.git` 固定为 protected path，导致
同一 Git mutation 在三平台具有不同能力边界。

同时，qualification probe 在 macOS 使用 `gitAccess=deny`，真实 runtime 却使用 allow，证据与被资格化行为不同构。即使
`git status` 或 `git diff` 看似只读，仓库和用户 Git 配置仍可触发 filter、fsmonitor、external diff、credential helper
等外部行为。审批只授权操作意图，不能安全地把通用 shell 的原生权限上限扩大到整个 `.git`。

项目现有 worktree controller 已实现清理环境、禁 hooks/credentials/fsmonitor/filter 等防护，可作为 broker 的实现基础。

## 决策

1. brokered-Git production profile 中，通用 shell 必须由 native boundary 拒绝直接或间接访问 Workspace Git metadata。
   文本扫描只作辅助诊断；approval 与 full mode 不能提升 native ceiling。backend `none` 或 bare host fallback 不满足该
   主张：该 profile 下 shell 应 fail closed；如保留 legacy development fallback，必须显式标记并排除 qualification。
2. Windows 当前 write-restricted backend 不能证明 `.git` read deny。Windows 只有引入独立 principal/更强 profile 并通过
   native read/write matrix 后才能取得 brokered-Git qualification；此前该 operation 为 `unsupported/excluded`，不得用静态
   ACL ledger 代替读取隔离证据。Linux 必须实现并验证 `.git` directory/file mask，不能仅依赖当前整 Workspace bind。
3. Core 定义 typed Git capability interface/spec，App 只提供受控 process adapter，保持 `src/core/` 不依赖 `src/app/`。
   `ExecutionCapabilitySurfaceV1` 增加独立 `gitInspect`/`gitMutation` axis，具有 model disclosure 与 dispatch 双门禁；
   generic read-only、write/process bit 或 in-process catalog 永远不能隐式包含 Git broker。
4. 第一阶段 `git_inspect` 只接受每操作固定、有界 schema：status、diff、log、`branch_list`；禁止任意 argv、shell、环境、
   config、format、pathspec magic、branch mutation。schema 明确 revision grammar、path 数量、输出字节、记录数与 timeout。
   模型不能提供 repo root 或 gitdir。
5. broker 绑定 canonical repository/worktree identity，并在首次 Git process 前以非 Git 执行路径安全解析 `.git`
   directory/file/common-dir，检查 local include/config、attributes、replace refs 与 grafts。Git executable 必须位于 Workspace
   外、canonical、受信 owner/ACL 控制，并把 binary identity 纳入 qualification；不得直接信任 PATH。
6. broker 清理 Git/credential 环境，关闭 pager、hooks、signing、credential helper、askpass、fsmonitor、external diff 与
   textconv，并拒绝 filter/include/replace/grafts 等外部执行或跨边界配置。现有 worktree controller 仅作为防护素材，
   不代表已满足 broker 的 preflight 顺序或 production admission。
7. protected-path evaluator 在执行前生成允许 path 集与固定 pathspec；protected path 的名称、内容和历史 blob 均不得通过
   status/diff/log 暴露。无法在 Git 读取对象前完整约束时 fail closed，不能先运行全仓 diff 再做字符串清理。
8. 第二阶段才提供 stage/commit；它们必须有独立 effect、approval 与 invocation receipt，禁 hooks/signing，并对
   clean/process filter 选择安全实现或稳定拒绝。remote operation 不进入本地 broker；开发 shell 的 legacy remote 不构成
   production support。未来若要求 remote-only capability，还必须增加 network/credential descendant boundary。
9. Git 与 shell 失败使用 ADR-0096 的 typed outcome，至少区分 `sandbox_capability_missing`、`protected_path_denied`、
   `git_operation_unsupported`、`managed_network_setup_required`、`repository_dirty`、`conflict` 与 `lock`。
10. 迁移前盘点 project scripts/build 对 Git child process 的依赖；broker 只保证模型/API inspect 连续可用，不承诺任意
    shell script 在 metadata deny 后仍能调用 Git。tool disclosure、dispatch 与 native profile 使用同一原子 feature revision
    切换；legacy/dev 例外必须写明平台、移除条件并排除 qualification。
11. probe 走与 production 相同 composition/input，证据分别绑定 sandbox profile revision/digest、protected-rules digest、
    broker revision、operation schema revision、repository binding、Git executable identity 与 invocation receipt。native shell
    negative、broker positive/hostile、TUI routing 是三组独立证据，任何一组不能替代其他组。

## 备选方案

1. **保留 ADR-0070 并加强命令正则**：拒绝。shell quoting、变量、子进程与解释器组合不能由文本扫描完备识别。
2. **让 Git 完全绕过 sandbox**：拒绝。会弱化 ADR-0054 的执行隔离，并扩大配置、凭据和 hook 攻击面。
3. **三平台继续使用不同边界**：拒绝。调用者无法获得稳定 contract，资格证据也不能代表统一产品能力。
4. **立即提供任意 Git argv typed tool**：拒绝。任意 argv 仍可使用 `-c`、`--git-dir`、alias 或 helper 重新引入逃逸面。

## 影响

- ADR-0070 的 `.git` allow 结论已被取代；在 brokered-Git 迁移完成前，当前行为仍以源码和 active 文档为准。接受时只把
  ADR-0070 状态与索引更新为 `superseded by ADR-0097`，保留其历史正文。
- 模型获得更窄但稳定的 Git 操作，跨平台失败可以给出明确 next capability，而不是反复修改 shell 命令。
- Git 功能将分批可用；不在 broker schema 中的操作稳定返回 unsupported，不通过通用 shell 绕过。
- native matrix 需要覆盖字面量/混淆/变量/子进程访问、fake Git/PATH substitution、binary/common-dir TOCTOU、protected
  tracked/history content、Git 环境覆盖、linked worktree/submodule、case/symlink、lock、backend none、broker unavailable、
  hostile config、commit timeout post-condition 与取消清理。

## 回滚

每个 typed operation 独立迁移并可回到上一 broker 版本。安全回滚 artifact 必须保留 shell deny；普通代码回退若会恢复
ADR-0070 的 allow，不是合格回滚。安全态是“operation 暂时 unsupported 且 shell 继续 deny”。旧调用路径只能位于显式
legacy development profile，限定平台和删除条件，并排除 production qualification。
