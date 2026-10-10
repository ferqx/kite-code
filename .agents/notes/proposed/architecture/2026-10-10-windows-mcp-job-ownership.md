# Agent Note: Windows stdio MCP 的原 Job 与严格关闭交接

Status: proposed

## Problem

正式 Windows Service 已有 MCP 来源、批准、SQL connection Job 和普通 Tool 消费者，但 stdio port 的平台 guard 阻止实际连接。直接 spawn 再按 PID／PPID 补 Job 有创建空窗；仅发 terminate、根退出或关闭 RPC 管道也不能证明后代和原资源结束。旧 Rust Shell token 不满足当前文件保护合同，不能借迁移 MCP 启用 Shell 或旧 carrier。

## Proposal

已接入源码的[Windows owner](../../../../packages/agent/src/platform/process/windows-owned-child.ts)在创建业务前建立无名非继承 Job，固定 KILL_ON_JOB_CLOSE、无 breakaway。CreateProcessW suspended 创建，准确三 stdio HANDLE_LIST，原 process HANDLE 归 Job 后才 resume。stdout／stderr 单消费者完整排空，stdin 使用私有 named pipe 和有限 overlapped write；cancel 后仍保原 buffer／event，实际完成或取消完成后才释放。开始失败交接原错误和 cleanup Promise，不能把已创建 suspended 进程当成零资源。

[Windows guardian](../../../../packages/agent/src/mcp/windows-stdio-guardian.ts)与[同一 port](../../../../packages/agent/src/mcp/stdio-port.ts)保持原 Source、六字段 binding、配置快照、startup 与 grace＋4000ms stop 预算。原 root wait／GetExitCode、Job ActiveProcesses=0、双输出 EOF、I/O completion 和每个原 HANDLE 关闭共同约束结束；parent 另核实际 spawn PID 的原观察 HANDLE／FILETIME、ready 自报出生、实际 guardian exit／close 和该观察 HANDLE 关闭。任何 unknown 保原 owner 与进程存活，首个 unknown 不被迟到关闭改为 ended。

closed v3 明确 coverage=windows-job-members，保存有限原出生、退出、空树及 observationClosed；不含 command、env、路径、native HANDLE 或秘密。原 Darwin v1／v2 codec 与[coalition 决定](../../implemented/architecture/2026-10-10-macos-mcp-owned-coalition.md)保持，纯 cold decoder 不加载 FFI，不产生执行或控制权。公共资产构建同时生成独立 Windows guardian；正式 Service 按实际平台定位包内 `.js`，不存在源码 fallback。

本提案保留 proposed：完整源码和本机控制流验证不替代实际 Windows Job／pipe／HANDLE、正式安装与维护恢复资格。当前事实归[MCP owner](../../../../packages/agent/src/mcp/README.md#windows-stdio-所属-job)。

原[Soak stdio调用者](../../../../tests/fixtures/unified-agent/soak/mcp-owned-stdio.ts)已切到同一Source／SQL Job／SDK和cold原结果，非macOS直接adapter回退删除。[纯交接校验](../../../../scripts/runtime/unified-soak-mcp-handoff.ts)按实际平台核原v3 FILETIME与ready→terminal连续性、root实际exit7、Job0、guardian实际exit0／reap／观察关闭及全部cold身份；formal缺交接拒绝。Windows ready尚未采样的activeProcesses:null不充作0。该调用者迁移源码不代Windows实际运行或全Runtime资源资格。

## Alternatives considered

- 直接 Bun／Node spawn 后按 PID 归 Job：业务可在 assignment 前派生或退出，无法证明归属；采用 suspended 原 HANDLE assignment 后 resume。
- 沿 PPID 枚举／数值 PID kill：父退出、reparent 和 PID 重用破坏身份，采用原 Job 和 process HANDLE，不从 cold receipt 重建资源。
- 复用旧 Rust Shell runner／token：旧保护目录为空，WRITE_RESTRICTED 不能证明 Profile 读隔离；会混用权限和旧运行图，当前 MCP 只复用已核 OS 算法，不接旧 workspace。
- 套用 Shell 文件／网络隔离：MCP 的明确可信 executable 与来源准入合同不同，会实质改变工具行为；保持独立 stdio transport owner，不将 Job 称 sandbox。
- 用 COMSPEC／PATH 或 `.cmd` 自动 fallback：无法保持明确可执行资产和准确 argv，当前要求绝对 native `.exe`；Node／Bun＋脚本参数仍可完整配置。
- 增加另一个 MSVC helper 或公开任意 HANDLE：现有 Bun 私有 guardian 可使用 lazy FFI；不增加构建资产及通用 native 权威接口。实际 FFI ABI 仍须 Windows 验证。

## Acceptance criteria

Profile／已批准 Workspace 声明经正式 Service、同一 SQL Job 与实际 SDK连接、工具调用、完整结果、准确取消、Service 关闭及 cold 原 C／E／output 零重放。原生 Windows 用例还须核原 FILETIME、创建前 Job 归属、root 实际 wait、空树、pipe EOF、overlapped completion 和 guardian observationClosed；原预算／断言不削弱。installed A→B→A、新 Store 维护与所有正式客户端按原能力映射另行完整验收，不能以该有限 owner 窗口宣布阶段退出。

## Risks

Job 覆盖原成员，外部 WMI／其他系统 broker 代启动的工作不在该范围，远端效果不因此停止或撤销。Windows Shell 当前仍因真实权限后端缺失拒绝，Task 子 Agent 本身仍在同一 Runtime／Store，不另建 OS carrier。Windows／Linux 原生资格按用户要求留重构后；RSS 与完整可信 Runtime 后代／activeResources／handles 门禁保持，直接阻 P6／§35，独立源码实现不以这些观测为前置。
