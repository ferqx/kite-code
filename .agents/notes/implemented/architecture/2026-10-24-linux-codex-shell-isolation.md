# Agent Note: Linux 本机认证目录隔离与正常 Shell

Status: implemented

## Problem

接入本机 Codex 后，认证文件必须保持私有，同时普通 Linux Shell 仍应正常执行。将文件当目录捕获会使 Run 准备失败；单文件 bind mask 又会在宿主原子刷新认证时失去保护。此前对所有含私有文件的 Shell 拒绝启动，影响了用户原有工具能力。该记录只替代[本机认证决定](2026-10-24-local-codex-authentication.md)中临时的 Linux Job 拒绝，保留只读来源、固定传输和账户身份边界。

## Decision

Linux 将可信私有文件的专用物理父目录交给既有 namespace 目录 mask；运行中的认证叶原子替换不会移除父目录 mask。普通 Workspace／Full 挂载和授权继续沿原路径，其他工作文件的新建、读取与修改保持真实宿主效果。原准确 Skill 来源只能经既有只读投影暴露，其余认证内容继续不可读写；不新增进程、broker、协议或执行循环。

发现、模型目录读取和 Run 准备保持只读。仅在真正已授权 Shell Job 派发时，可通过最近存在父目录的原 FD、逐级 no-follow 和身份复核创建缺失专用目录，权限为0700。该有限基础目录预留不写认证或配置正文、不修改既有目录权限，也不在退出时删除共享目录。取消检查贯穿准备过程，业务进程仍在原 native gate 之后创建。

认证目录不能替代整个 HOME、Workspace、运行资产、临时根或其祖先；未被原私有根保护的符号链接别名也不能成为可被业务重定向的认证入口。此类无效布局仅使原 Shell Job 明确失败，不阻断普通 Run 准备，不以全 HOME 遮罩或私有写入副本改变 Full 语义。默认 `.codex`、独立自定义目录和 Workspace 内的私有子目录均沿正常工具路径执行。

默认来源先对已存在的绝对 HOME 做只读物理路径归一，来源读取与保护消费者共享同一 `authPath`，避免系统 HOME 别名使正常默认布局误报。显式 CODEX_HOME 仍保其原拼写和保护约束；缺失／相对 HOME 不因归一取得新资格或触发创建。

原 Linux 布局还需剔除外层 mask 内不可见且无用途的祖先 self-bind；全部原宿主身份仍复核，准确来源投影的 scaffold 仍保留，native 子挂载检查不放宽。这使正式 Profile 的深 coordination 路径能通过同一 gate，避免只在浅层夹具可用。

## Alternatives considered

- 删除私有文件保护或只检查启动时文件：普通工具可读到模型凭据，后续刷新也不受保护。
- 使用精确单文件 bind：宿主 rename／unlink 可移除另一 namespace 的挂载点，不能证明长任务期间持续保护。
- 将所有含本机认证的 Linux Shell 禁用：能失败关闭，但违反正常工具执行目标；由本决定替代。
- 遮罩整个 HOME 或使用改变普通写入去向的 overlay：扩大影响范围，改变 Full 的真实宿主写入语义。
- 对尚不存在的挂载点隐式建立目录：副作用与身份不明确；改为仅在派发时通过原父 FD 受控预留。
- 新增路径 broker 或依赖额外 LSM 策略：超过复用现有 namespace 边界所需范围，且引入新的部署或执行控制责任。

## Consequences

Linux 的秘密隔离范围是专用认证目录，而非单一叶名称；目录内其他私人内容也不暴露给普通 Shell。无效重叠或可重定向布局需要独立物理认证目录，不能借批准放宽。缺失目录的基础预留是 Shell 派发阶段的有限写入，不是只读认证发现的写入，也不是业务命令的重放。

[布局回归](../../../../packages/agent/test/isolated/jobs/linux-preparation.test.ts)、[目录准备](../../../../packages/agent/test/isolated/jobs/linux-private-directory.test.ts)、[实际 namespace](../../../../packages/agent/test/isolated/jobs/linux-native-shell.test.ts)和[默认 Service／Codex](../../../../apps/service/test/isolated/codex-connection.test.ts)分别核对静态布局、父 FD／取消／无效来源、长任务认证轮换及完整工具链。实际环境和验证范围归[Jobs owner](../../../../packages/agent/src/jobs/README.md#linux-宿主与严格补偿源码)，不是安装包或所有 Linux 内核的资格。
