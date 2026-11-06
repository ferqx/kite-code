# Agent Note: Git Worktree 沿现有 Shell Job 执行

Status: implemented

## Problem

模型需要查询、创建和安全删除当前来源仓库的工作树，但 Git 变更会同时影响目标、共享元数据和 refs。普通 clean 不能证明 ignored/空目录/索引标志或 reflog 独有提交可删除；Runtime记录与ensure不在同一事务，重试也不能推导原变更未发生。用户确认的 V1.2 要求只交付一个工具的三个 action，保留权限、进程监管、取消、记录与恢复。

## Decision

`builtin.shell/git.worktree@1` 复用 `shell.command@1`，由受信任 Bun worker 以固定 Git argv 执行。没有新增 Runtime、Job、工作树管理数据库或 Session cwd 迁移。[工具 owner](../../../../packages/agent/src/tools/git-worktree/README.md)维护完整当前契约和限制；[Service](../../../../apps/service/src/worktree-host.ts)仅从既有权限绑定与目录查询提供证据。

同 Session 执行记录首次CAS即带executable来源，冻结完整意图/期限/步骤；新Execution同key只能观察原ref，不能补发记录间隙中的变更。原owner合法resume逐字续接，unknown不成为稳定缓存。创建固定OID并先无checkout登记，在实际目的配置中禁用filters后只填充当前worker刚分配的目标。删除保护完整本地内容、路径代际、HEAD及reflog的old/new提交；保留引用仅为共享本地分支与可剥离tag。检查不完整保留现场，不自动force、prune、清分支或递归删除。

原 owner 独占后续执行记录 CAS，其他 Execution 的 unknown 或确定观察不回写该记录，避免观察打断活跃 owner。删除内容证明不依赖 Git stat 缓存：已打开普通文件 FD 经 Git 内建 clean 转换重新计算 OID，并核完整 retained blob；目录名称、代际和挂载证据在最后异步检查后同步复核。保留引用还须有独立共享存储，符号链不能依赖 worktree HEAD，packed refs 不能通过文件系统链接落在待删 admin 内。完整规则及回归由原工具 owner 维护。

只读角色及Planning批准前只放行真实list。Planning使用精确原Execution/input SHA与Host重建资产核验，不能把混合工具加入整体只读名单。内层Job仍独立核验当前权限与派发资格；原业务批准的准确复用及成功创建通知由[后续决定](2026-11-06-worktree-business-authorization-and-notification.md)补充，不再要求同一业务意图逐阶段重复确认。实际worker范围取原申请与接纳证明交集，Full不自动扩大默认filesystem或network。环境与Bun保护在首个解释器前生效；Bun1.4.4配置参数按实际探针使用单参数`--config=<absolute>`，避免退出0但未运行脚本。macOS固定可核验的系统native Git，不能以Apple调度桩的hash冒充实际实现并依赖沙箱外缓存写入；可信worker输出在首层严格UTF-8解码，普通Shell行为保持。

Windows仍遵守[原工作树清理决定](../../implemented/process/2026-10-19-windows-worktree-cleanup.md)，该决定继续适用；本工具不新增清理豁免。空hooks发行目录由准确封存三文件闭包派生并由原归档/安装路径恢复，不升级manifest协议。

## Alternatives considered

- 直接在Tool handler启动Git：不能复用既有Job监督、权限、完整输出和取消边界，不符合已确认路线。
- 新建Git Broker、Job类型或工作树管理库存：引入独立authority和恢复路径，超出三个action的授权目标，未采用。
- 把模型字段拼成Shell Git命令：不能提供固定可信只读证明或可靠路径编码，未采用；Shell只承载规范化worker入口，Git在worker内部使用argv。
- 崩溃后以新Execution重发或按相同path/HEAD继续checkout/delete：无法证明原效果未发生或实体未替换，未采用；首版宁保留unknown与人工定点运维边界。
- 仅补强 Git stat 配置或比较原始文件字节：前者仍不能独立证明内容，后者会误拒 CRLF、ident 和编码转换产生的正常 checkout；采用禁用外部 filter 的 Git 内建转换及完整对象证明。该选择增加只读检查成本，不增加写入或网络资格。
- 让同 key 观察者保存 unknown／prepared：会抢占原 owner 的 CAS revision，原变更尚未派发也可能因此中断；采用纯观察返回，稳定持久化与原消息身份仍由原 owner 恢复负责。

## Consequences

三个action在合格Service Host和现有模型/Job链路上可达，创建不切换来源或cwd。删除检查比Git默认clean严格；仓库锁不构成所有外部进程或其他Run的全局占用租约，未知锁不自动抢占。legacy无scope-aware host只支持list，自定义zsh等可加载启动文件的环境不取得该工具能力。

macOS真实Git、故障窗口、只读/Auto/Planning、原Shell监管及安装搬迁验证归[测试入口](../../../../packages/agent/test/isolated/tools/git-worktree/README.md)、[Service证据](../../../../apps/service/README.md#默认-shell-装配)和[Terminal owner](../../../../apps/cli/docs/terminal-release.md)。Linux/Windows代码接线不等同实机监管、reparse或完整三平台发行资格。没有承诺冷Shell进程重连、自动完成每次崩溃、外部进程占用检测或工作树沙箱隔离。

默认创建路径与普通 Shell 路径政策已由[持久默认目录决定](2026-11-06-persistent-worktree-default-and-shell-path-policy.md)局部调整；原 Git argv、重叠／删除保护、记录／恢复及平台限制继续适用。
