# Agent Note: Windows managed Terminal 在加载前固定前门与原对象

Status: proposed

## Problem

正式安装、运行中升级、明确回退和保数据卸载必须共享准确候选使用权。Windows 无法用 POSIX shell/flock/fsync 或 mode 位取得该资格：Bun 在入口 JS 前读取环境与本地配置，helper 自身也需要加载前身份；普通 deny-DELETE pin 与最终删除所需 DELETE HANDLE 不能关闭后重开并宣称还是同一对象。把协调锁留在待删除安装树内，还会使原 holder 与重新安装者落在不同权威上。

## Proposal

固定 x64 native `kite.exe`／`kite-tui.exe` 作为第一阶段，静态 CRT、闭合系统 DLL import、预初始化清理五个环境键，按实际 module path 固定 prefix，保自身/祖先及准确 helper 的原只读 HANDLE至 helper 实际退出。独立 compiled verifier 关闭配置自动加载，selection SH 内核 format=2 bootstrap、全部前门、current、原候选 SH 与完整文件清单，才启动固定配置的候选 Bun。父 paired CLI 和实际 Service 各持自己的 SH/pin；当前 Native 登记与 Main 加载前 guard 保持，不把 Terminal helper 当 Node 使用权。

所有新 PE 副本的现存 LoadConfig 字段显式封闭 `DependentLoadFlags=0x800`，原 Bun 不修改；缺少字段/有 delay import/带路径 DLL 拒绝构建。第一阶段设置 DLL 策略不能推导 helper/Bun 已取得相同策略，故逐产物处理。该字段的静态 import 搜索要求 Windows 10 RS1+，依据 [Microsoft 文档](https://learn.microsoft.com/en-us/cpp/build/reference/dependentloadflag?view=msvc-170)；动态加载、签名和发布者资格仍独立未验。

Windows npm 闭包物理展开，包内最近祖先保持真实版本/peer/alias，文件资源和许可证不变，无 symlink/junction/hardlink 或另造 `.bin`；同版本循环复用原祖先，无法有限表达的遮蔽循环明确拒绝。POSIX 默认 linked 布局保持。当前真实锁定图的本机完整字节/边核对与搬迁解析是布局证据，不代替 Windows ABI/ACL。

prefix 外稳定 current-SID 私有 namespace 绑定规范化 prefix，保原 marker 和祖先，并承担 selection 与 candidate 使用锁。format=2 marker 固定原 bootstrap A，B 的 active 发布不覆盖前门。有限 stage 也在该 namespace，原私有 CREATE_NEW/短写/Flush 与同卷 move 接入原安装流程，whole verify及读回后才确认发布。namespace 留过卸载/重装，独立 Profile/data-root 不在删除树内。

卸载先取得 selection EX 和全部 candidate EX，再以完整库存保从开始就具 DELETE 权限的原 HANDLE；whole verifier核同一 WeakMap 记录的 owner，逐叶 disposition/Close 后确认根不存在。没有“先普通 pin→关闭→按路径删除”的handoff。所有实际资源先确认关闭再交权威；未返回 deletion port 的 acquisition-cleanup unknown，也以准确错误类型保全外部 EX。失败准入保原错误和未知关闭，强保准确资源至收尾/宿主退出。

当前源码已接入，但原生 Windows 编译、PE loader、DACL/sharing、完整 installed 生命周期尚未执行，保持 proposed。当前负责事实归 [Terminal owner](../../../../apps/cli/docs/terminal-release.md#windows-managed-terminal-当前实现)、[Agent 平台](../../../../packages/agent/src/platform/README.md)及 [Service owner](../../../../apps/service/README.md)。

## Alternatives considered

- 把固定 JS/Bun helper 放在 candidate 中先 hash 再启动：helper 与 Bun 初始化已先读取不可信环境/配置，且普通读完关闭留下替换窗口；采用原生前门及持续原对象 pin。
- 只在父设置 DLL 搜索策略：每个新进程初始化静态 import 时仍需要自己的约束；对第一阶段、helper 和候选 Bun 各核实际产物字段，不推导继承。
- Windows 沿用 POSIX internal links 和 `chmod/fsync`：链接权限与真实 DACL/HANDLE 不能用 POSIX 邻接证明；采用物理普通文件布局和现有原生文件端口。
- 在 prefix 内持 `.install.lock` 和 candidate `.use` 后重命名删除：锁本体留在将删除的树中会阻删，并可能在重装后形成两个协调对象；固定外置 namespace。
- 卸载时关闭普通 pin、再调用递归路径删除：交接不绑定原对象和完整库存；使用独立 DELETE-purpose owner，whole read复用它。
- 每次 B 升级覆盖稳定前门：运行 A 的原 image/文件对象仍需保活；marker 固定最初 bootstrap，后续仅交换已完整验证的 candidate 指针。
- 暂时移除 Native guard、跳过平台失败：不能证明 Node 加载前同一原 addon 对象或完整平台能力；保现有拒绝和原 common/native/formal 门禁。

## Acceptance criteria

实际 Windows x64/RS1+ 的准确已构建候选，经原 pack/unpack/install，标准 `.exe` 前门在恶意 cwd preload/五环境键下仍只使用固定字节。真实 paired Run A 保原 SH 与独立 Service SH，升级 B/回退不切换 A；live拒绝卸载，A完成及双 EOF/真实退出后全候选 EX可取得，B冷读原完整身份/结果且零 Model，卸载保 DB/config 原字节。工具不使用 availability skip，120秒整链/30秒命令预算保持。

真实 PE缺字段、原 HANDLE拒写/拒删、ACL/reparse/alias、实际 native发布/删除与未知关闭必须本平台核对。B标签只证明指针，不代跨代码；TUI help不代PTY。完整 Windows backup/inspect/restore/status/GC、Daemon、Native Node handoff、持续资源和跨平台完整回归仍按各 owner 独立验收，不提升37能力或§35退出。

## Risks

Bun 当前真实 Windows PE 是否满足现存 LoadConfig/无delay import 尚待编译产物验证；拒绝不能用构造缺失字段或放宽导入名单绕过。枚举全树/大量普通副本增加构建量，源码变更后的边/字节证据需重新核对。write-through/Flush、进程中断和最后路径复核不授予断电原子性或对同 SID 非合作编辑器的通用防护。partial init、坏 bootstrap或未知 native publication明确拒绝，不自动修现有对象。

本提案只补完整 Terminal 安装所有者与前门，仍适用的 [Node 加载前身份/独立 holder](2026-10-04-windows-node-owned-profile-and-artifact-leases.md)、[私有/Workspace角色](2026-10-04-windows-private-and-workspace-scope-paths.md)、[immutable媒体](2026-10-04-windows-artifact-handle-publication.md)及 [维护发布](2026-10-07-windows-maintenance-file-publication.md)理由保持；没有替代其未完成验收。
