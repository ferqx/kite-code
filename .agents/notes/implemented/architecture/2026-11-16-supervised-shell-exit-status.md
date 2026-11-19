# Agent Note: 受管 Shell 保真传递退出状态与交付边界

Status: implemented

## Problem

Windows PowerShell 的包装脚本可将单条原生命令的非零退出报告为成功。Shell 产物按生产 Job 的终态归档，模型也用该终态判断是否需要恢复。第三方技能共用 Shell，需要同样的依赖诊断、工作目录和交付约定。

Git for Windows 更新可移动原生工具目录。固定目录会漏掉真实 Git，影响 Git Bash Job、只读 Git 查询和工作树操作。

## Decision

PowerShell Runner 透传可确认的单条原生调用的非零退出码。未捕获的命令查找或启动异常使用一致的 Shell 退出码和原错误信息。模型从既有 Job 结果读取退出码，并在实际 Job 中按需诊断依赖。中间文件留在工作区，成品由最终成功 Job 的输出目录归档。

PowerShell 复合脚本按系统 `-Command` 的顶层作用域执行。Git Bash 长脚本超过 Win32 启动参数上限时复用本次 Job 的私有输入管道，完整读入后执行。两个改动由同一个 Windows runner 提供，适用于使用相应 Shell 的任意脚本和 CLI。

复合脚本的结束状态在原 AST 各根执行块内由 `finally` 捕获，随后在原顶层作用域结算。dot-source 或 `Invoke-Expression` 调用结束后再读 `$?` 会重置部分原生命令失败，不能作为原脚本的状态证据。按实际 AST 能力处理根块，不按 PowerShell 固定版本拆分；保留参数、提前返回、函数／类和显式退出。终态确认进程树与清理完成后，通用模型反馈明确进程内状态已结束，后续从已保存文件继续，不保活已结束 Job 的驻留进程。

Windows 原生 Job 将系统退出状态、停止后的活动数、标准管道排空和直接关闭句柄的结果随原终态保留。诊断来自 Runner 的私有 stderr，大小和字段均受限，停止及授权依据仍来自原监督链。等待确认自然退出后才读取实际退出码，查询失败保留未知。Windows 返回 Job 停止请求成功后仍须核实活动数归零，诊断保留过程错误以便排查。 [Shell owner](../../../../packages/agent/src/jobs/README.md#默认-windows-git-bash)

Windows 命令查找的恢复线索属于观测到查找未命中的原 Job，脚本可自行处理未命中并保留最终状态。使用有界解释器证据，或字面量独立查找的可核实结果，确定待查名称。Windows paired 启动按显式白名单传递本机工具目录。候选表达文件与来源事实，读取路径和后续执行继续沿 [Windows Shell 合同](../../../../packages/agent/src/jobs/README.md#默认-windows-git-bash)。 [命令查找回归](../../../../packages/agent/test/isolated/jobs/windows-command-lookup.test.ts)

Git Bash 从 Kite 进程 `PATH` 已解析的 Git 定位安装，按实际程序和 helper 布局生成两套私有运行时。Job、只读查询和工作树操作使用同一清单定位所需副本，派发时重新核验实际资产。独立 Git 继续用于 PowerShell 的 Git 操作。见 [原 PowerShell 回退决定](2026-11-12-windows-desktop-powershell-fallback.md)。

完整文件范围的副本后来由[原位使用已安装 Git Bash](2026-11-19-windows-installed-bash-full-access.md)部分替代。程序布局发现与 Runner 所有权继续适用。

## Alternatives considered

- 按技能或依赖的名字修补环境。故障涉及任何原生程序和技能，采用共用 Runner 与工具说明才能覆盖用户自装技能。
- 把脚本内出现的任何非零或 stderr 判失败。脚本可以有意处理搜索未命中或诊断警告，须保留显式控制流。
- 将 dot-source 换成 `Invoke-Expression` 后再读取 `$?`。两者均在调用返回后重置末尾状态；实际 5.1 与本机最高版本的原生对照否定了这一方案。
- 给 Bash 直接使用会逐段执行的标准输入脚本模式。子命令可能先读取尚未执行的脚本内容，因此先完整接收长脚本，再按用户命令执行。
- 列举 Git 的已知程序目录。新布局会再次要求更新列表，已发现安装的程序和 helper 文件已足够说明实际布局。

## Consequences

动态调用和多步脚本可显式处理预期非零并决定最终状态。依赖诊断与后续执行使用实际 Job 的权限及环境。Git 启动器对应的安装需能识别出唯一完整程序树，直接从 PATH 解析到程序时使用该树。当前合同见 [Windows Shell](../../../../docs/active/windows-shell-sandbox.md)和[产物收集](../../../../packages/agent/src/business/output-collection.README.md)。

## Verification

真实 Windows Job 回归覆盖原生非零、预期非零处理、查找和启动失败、Git 和原进程树停止。Windows 桌面 Service 的 PowerShell／Git Bash 与内置／用户安装技能四组对照，核模型收到退出码、跨 Job 复用中间文件和只归档成功交付。实际进程及证据范围见 [Windows Shell](../../../../docs/active/windows-shell-sandbox.md)。
