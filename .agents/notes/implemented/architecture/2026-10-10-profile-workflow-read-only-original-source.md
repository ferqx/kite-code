# Agent Note: Profile Workflow 在原目录读取准确来源

Status: implemented

## Problem

正式 Skill Source 同时准入 Workspace 与选中 Profile 的 Skill。脚本 verifier 必须在原 canonical Skill root 执行固定 Bun 和相对 entrypoint，并以原 Workspace 取得写范围；整个 dataRoot／coordination 的保护不能因启用 Workflow 解除。原 macOS 正式 verifier 仍使用普通进程组，切到完整 host 后端会被保护根内 cwd 拒绝；Linux 也有相同来源缺口。

`contract.files` 明确忽略 `node_modules`、`build`、`dist` 等目录。只封存这个集合不能代表整个原 Skill 目录、相对依赖和 package resolution，复制一个入口或改变 cwd 也不能保持原执行语义。允许读取整个 Profile 又会暴露无关数据和协调材料。

## Decision

可信 verifier 在完整原来源、revision、依赖、output 和 script strategy 复核后，仅为实际 Profile 来源提供准确 `readOnlySourceRoot`。它不进入 Job JSON、HTTP 或模型参数，必须准确等于 canonical cwd、位于保护根严格内部，不包含 Workspace 或任何另一个保护根，不与 control 重叠。普通 Shell 和固定 confined 没有此例外。

来源仍是原完整目录子树；原 compiled 文件和目录身份复核保持，被忽略资源可相对读取但不因此参与 revision 摘要。macOS 在私有读取 deny 中精确减去来源子树及必要祖先 metadata，另拒绝祖先 data／xattr 读取。整保护根写入、unlink／移动、ioctl 与 native exec-map 仍禁止，Full 不能搬走来源或祖先。固定外部 Bun 解释原文本，来源中的 native 文件不因可读取得执行资格。

正式 macOS verifier 已接完整原 coalition 后端，原 cwd 与 Workspace 各自捕获，最终授权核实际 `skill.workflow.verify`。Linux 源码沿同一可信交接生成私有 tmpfs 祖先链，再精确 ro-bind 原来源；init 在业务 gate 前核闭合子项、原 FD／来源身份和逐 mount 的只读／noexec／nosuid／nodev，严格关闭新增 FD 后清空 capability。Linux 原生资格仍归[原 namespace 提案](../../proposed/architecture/2026-10-10-linux-shell-owned-pid-namespace.md)，未据源码取得平台资格。

## Alternatives considered

- 将 `contract.files` 封入副本后改 cwd：忽略目录不在该集合，原相对依赖、路径和 package resolution 会改变，不能称完整能力迁移。
- 开放整个 dataRoot／Profile：与私有数据、协调和凭据保护冲突；只开放准确 Skill 子树及必要 metadata。
- 保留正式 group verifier 或回退普通 Shell：不能证明转组／孤儿后代完整结束，Linux 缺隔离时也不能借此继续执行。
- 拒绝所有 Profile Skill script：与已准入 Profile 来源和原脚本合同不符；保原 cwd 及准确只读来源可以在既有授权内实施。
- Linux 先将 scaffold 封为0111／只读再校验子项：init 仅持 CAP_SYS_ADMIN，无法从新路径枚举该目录，也不能在只读 mount fchmod。采用业务尚未创建时的0700私有 tmpfs、原 DIR FD 闭合校验、0111／mount 封存与原 FD 复核；业务不接触过渡状态。

## Consequences

新增的是准确来源读取与正式 verifier 迁移，不增加来源写权限、执行 grant 或任意同 UID 外部非合作替换的防护。Workspace 来源继续使用原授权写范围；严格补偿仍使用独立只读副本、禁止子进程和独立 Job 审批。本决定不替代[默认 macOS host 决定](2026-10-07-macos-host-shell-owned-coalition.md)或[补偿决定](2026-10-03-declared-workflow-compensation.md)的其他边界。

本机 macOS 原生整例实际核 Workspace／Full 来源读取和拒绝、原子树／祖先保护、来源漂移零启动、准确取消／超时整树证明；正式 Service 整例另经真实 Runtime／SQLite／激活／独立审批／原 verifier proof 和冷全等零重放。Linux 纯准备／交接与 C 语法适配只证明对应断言，Linux mount／Bun 加载／退出及 installed 资格尚待执行。原 RSS／观测、Windows 权限和完整阶段退出门禁保持。

当前实现与验收由[Jobs owner](../../../../packages/agent/src/jobs/README.md#profile-skill-的准确只读来源)、[Workflow owner](../../../../packages/agent/src/business/skill-workflow/README.md)与[Service owner](../../../../apps/service/README.md#有条件-skill-workflow)维护，准确运行范围和保留失败归[当前进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10profile-workflow-原来源与正式-verifier-迁移)。
