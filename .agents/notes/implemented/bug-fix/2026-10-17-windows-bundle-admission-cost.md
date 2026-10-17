# Agent Note: Windows 闭包准入与打包成本

Status: implemented

## Problem

完整 Windows 候选包含 22,309 个清单文件。daemon 在准入后组装 Service 时重复取得同一进程的全闭包；归档和前门也在持有完整原文件集合时重新取得一份。逐叶路径读取、安全描述符的高级继承查询和大量已经可以内联的 JS 依赖副本使真实启动与安装准备超过原门限。仅在小 fixture 中通过无法证明完整安装可用。

## Decision

仅 Windows CI 转到上游 1.4.3 补丁版，Linux/macOS CI 与 formal 资格基线保留 1.4.2。保留固定 tsconfig、preload/env 隔离与零意外 stderr 断言，直接采用上游的 directory-mismatch 修复。官方资产摘要校验后，实际 PE/DLL 阴影、SQLite、原 scope/ACL 和 Node 配套反例先行验证；SQLite 3.53.4 的准确 sourceId 已在原审查集合内，不放宽来源集合。旧 1.4.2 的实验 census 补丁与 Darwin 校准不迁移、不授新版本资格；完整观测工作保持原收束边界。

每个实际进程继续独立取得使用锁与原文件所有权。Daemon 把本进程已经完成的准入通过可信装配参数交给 Service；WeakMap 只接受原 live 对象，绑定完整 proof、entry、executable 和 build。每次借用仍以原句柄重新验证完整库存、全部 SHA 与有效 ACL；原文件不可写不能代替新增目录项检查。借用未归还时原 owner 拒绝关闭，关闭开始后不能再借用。此对象不进入 startup JSON、配置、HTTP 或 Model，也不能从父进程跨进程继承。Native Main 的既有同进程借用仍见[原对象决定](2026-10-17-windows-original-object-sharing.md)。

原文件继续请求真实数据读取权限并拒绝 write/delete sharing，原祖先继续保持 traversal/no-delete 保护。临时重开探针只请求 READ_CONTROL 和 FILE_READ_ATTRIBUTES；它仍逐项核当前命名对象的原 identity、完整 stamp 和 ACL，持续保护来自未关闭的原强 HANDLE。原 HANDLE 同时提供已检查的类型、大小和身份，并用于完整字节读取与 SHA，不再通过 JS 文件路径重复打开。事实只能从原 opaque owner 读取；复制、伪造、错根、关闭或部分关闭的对象不能授予读取权。每次完整验证仍扫描准确库存、计算全部 SHA 并复核原对象，不缓存内容验证结果。

安全描述符从原 HANDLE 读取 self-relative owner/DACL，使用系统 GetKernelObjectSecurity；保留全部 owner、DACL present/protected、ACE 类型/范围、SID、权限及继承 grant 的原策略。高级 GetSecurityInfo 对 INHERITED_ACE 的展示处理不成为授权依据；所有有效 grant 仍被逐项检查，deny 不补偿不安全 allow。查询缓冲只在同步、私有 reader 内复用，不来自调用者。C 前门、Node-API 与 Bun 使用同一原对象查询语义。

归档在原 SH/full pin 下读取准确字节，压缩后的全库存/全 SHA/原对象复核仍保留，关闭未知持原 owner。私有批量写入/复制只减少重复持有相同祖先，仍使用 protected SID DACL、CREATE_NEW、短读写核对、每个原文件 Flush、原对象复核和严格关闭。每个 source 仍受原只读 pin 保护；未确认关闭不允许删除未知 scratch 或释放其安装 owner。

AI、Agent、Service 与 UI 的已声明普通 JS 依赖由现有 Bun 编译器内联，构建后扫描全部生成模块和 Worker，拒绝这些依赖的残余 bare import。Native 模块、WASM 位置资产、jsdom 的动态资源以及 React/React DOM 保持原外部解析与全字节复制；UI 显式声明 React DOM peer，避免内联 Radix 后丢失这条原运行依赖或复制第二份 DOM renderer。每个内联 root 附带实际安装声明图的原 manifest UTF-8 字节、manifest/notice SHA 与原许可全文；记录明确覆盖声明图而非声称所有分支均被执行，原外部图的版本、peer、optional、资源和无链接物化合同不变。

TUI 的 renderer 与 hooks 通过同一次 splitting 构建共享 Ink，CLI 使用 `@kite-ai/ui/tui/ink`；React 保持同一外部 peer，避免两份 reconciler/context。Ink 7.1.1 的两个 DEV 分支仅在核实原模块和结构后编译关闭，devtools 子模块是不可用 stub，正常 dev/prod 制品不能通过环境启用该调试入口。版本或原结构变化使构建拒绝；不修改安装的上游文件。普通输入、取消、完整正文、配套 Service 与关闭行为仍由实际客户端验收。

完整 Native 验证另暴露当前已安装 Electron 输入缺少两份 scale pak。生产构建预检与 Windows manifest 现在要求三个实际窗口资源包为非空普通文件，不能用完整 Node/SQLite 探针代替窗口。新隔离输入使用与锁定 npm checksums 及官方 SHASUMS256 相同的原 ZIP；不补写或修复既有安装，也不据本地摘要建立发布者真实性。有限 fixture 只增加闭合资源条目，仍不冒充可执行 Electron；缺包但自洽的清单与提前构建拒绝有独立反例。

## Alternatives considered

- 延长 15 秒启动、120 秒安装或命令门限，跳过整文件测试：不能证明原产品和发布边界，未采用。
- 省略 SHA、库存、ACL、跨 await 复核或 Flush：会丢失完整性、原对象或持久化边界，未采用。
- 为每个文件改用额外的手写 NtCreateFile 相对打开：本机实验未显示足够收益，未纳入实现。
- 为每次 Flush 创建并行原生线程：诊断中有收益，但增加线程所有权与关闭不确定性；优先减少重复文件副本，未纳入实现。
- 任意裁剪 npm 文件或无差别内联资源库：无法证明动态资产仍可独立搬迁；只接受明确的构建声明与生成物检查，保留资源库。
- 单独内联多份 Ink：renderer/hooks 会落入不同 context；共享同一编译入口和外部 React。
- 用 cwd pivot/preload 取代固定 tsconfig override：初始有限 alias 实验虽无警告，更强的通配 alias 反例仍实际执行恶意模块，已撤回。保留原固定配置和实际 stderr，不通过过滤 Bun1.4.2 的上游 directory-mismatch 警告满足零 stderr 门禁。

## Scope review

当前工作树覆盖前面连续授权的多组修复，不宜作为一个没有分组证据的发布改动审查。因果边界如下；完整资格状态只归 owner 的当前运行记录。

| 改动组 | 原失败与必须涉及的 owner | 不能省略的验证 |
| --- | --- | --- |
| Files Node-API 与路径展示 | 外部 Windows 路径拒绝、默认工作区路径缺失；Agent 的 Files 能力和 Service 配置、Desktop 工具消息共同负责。用户已明确要求 cap-std/napi-rs 替换 Files 手写 FFI | 真实 ACL、链接/别名、原句柄生命周期、Bun/Node 搬迁和完整输出路径；不以 Node-API 加载成功代工具语义 |
| PE 和正式启动参数 | 原 Bun delay-import 门禁拒绝、分离配置参数未执行应用；release builder/前门必须在加载前封闭导入与固定配置 | 实际 no-delay/System32/DLL 阴影、恶意 cwd 配置、正文执行、SQLite 精确来源；不改导入 allowlist |
| 原对象 I/O 与批量私有复制 | 原完整 22,309 文件候选准入/归档超时；platform owner 负责 HANDLE、ACL、复制和关闭 | 原 write/delete sharing 拒绝、全部库存/SHA、每文件 Flush、短读写与未知关闭；原超时不变 |
| 同进程准入复用 | daemon 重复取得本进程闭包导致启动未知，Node Main 重复无 owner 扫描；Service/Main 负责可信装配 | 伪造/复制/错根/关闭拒绝，借用阻止关闭，新增文件/目录拒绝；子进程独立完整准入 |
| 普通 JS 物化 | 重复普通 JS 图使完整私有复制/校验超预算；各 workspace build 与 release 物化共同负责 | 原解析边/peer context/optional 缺失、多版本、原资源/许可字节；实际 CLI/TUI/Native/Worker；静态 import 扫描只证明其覆盖的边 |
| Native Windows 接线与输入 | 完整长路径触发 CreateFileW 错误3，Node/libuv 原 Job 破坏 EOF 收尾；Node adapter/原生 owner 负责。Electron 缺两份 scale pak 是构建输入的完整性缺口，不是已证明的 UIA 超时原因 | 超过260字符实际 Node-API、固定 argv、原父退出后的 EOF/自然清理；最小资源缺失反例与真实窗口分别验证 |
| Windows 夹具 | POSIX 路径/权限、过时配置 authority、UIA 异步与短正文内联假设 | 实际安装前门、正常窗口完整正文、原 Store/Command/Run/Execution、零重放、自然退出/Job0/双 EX、真实引用媒体的维护恢复 |
| 共享测试路径 | 用户新增跨平台测试要求；固定临时根、手拼 file URL 和 POSIX mode 使原业务用例在 Windows 进入断言前失败；改动属于八个测试 owner 与共享夹具 | 真实 OS 临时目录、私有 ACL/公开权限反例、链接指向的实际外部普通文件、Unicode/百分号 URL 往返；原容量、默认调度和超时不变 |

审查撤回了对全部 CI、Linux formal 校验、Darwin/实验 census 基线的 1.4.3 迁移；只保 Windows runner 的上游修复。CI guard 的三条旧 owner/20分钟断言按 c1714314 已迁移的实际合同归位；该历史提交已把 workflow 从20改为30，本次未修改 workflow 时限。工具 smoke 恢复原每命令 20 秒，不再保留单独 Windows 180 秒预算。没有继续内联 jsdom、调整压缩算法、增加父 helper 或改写 daemon 进程创建方式。

同进程借用审查新增真实反例：在原 owner 存活时添加未知文件，旧借用路径实际没有拒绝。现在借用调用原 retained owner 的全库存/全 SHA/ACL 复验，并补回 Native retained 外层 pin 的 verify；不能以 WeakMap 身份或初次准入代替持续安全。该反例先红后绿，子进程准入和原关闭未知保留。

许可审查另发现 provider-utils、drizzle-orm、Hugeicons、scroll-bar 和 yoga-layout 等实际声明节点没有顶层 notice 文件，原 generator 只保 manifest 摘要，丢失其中的许可声明。现在 BUNDLED-DEPENDENCIES.json 与 THIRD_PARTY_BUNDLED.txt 均保完整原 manifest 文本，含仅 manifest 中声明的许可；不合 UTF-8 原字节拒绝。新的 metadata-only 许可反例先红后绿；没有增加依赖或执行包代码。

## Consequences

上述代码不改变用户的文件授权、正常客户端流程、取消或维护合同，不建立 publisher authenticity，也不凭编译或 mock 取得 Windows 完整资格。当前制品、完整安装、Native 窗口、维护和剩余限制分别归 [Terminal owner](../../../../apps/cli/docs/terminal-release.md) 与 [Native owner](../../../../apps/desktop/docs/native-release.md)。原反例和新增 opaque owner/许可来源反例进入完整 Windows 发布测试；各实际 gate 的结果必须独立报告。
