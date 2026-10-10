# Agent Note: Native 完整闭包与独立终端前门登记

Status: implemented

## Problem

Desktop 安装需要让标准 `kite` / `kite-tui` 选择它自己的 CLI、Bun 与配套 Service，同时让已运行的旧实例保留原资源。仅登记可执行路径会混入独立 Terminal 或环境依赖；卸载、更新和多个 Native 安装还会相互覆写前门选择。Node Main 与 Bun helper 对继承 descriptor 的解锁不能破坏原进程仍在使用的候选。

本决定覆盖新 POSIX 安装与本机 macOS 验证；当前产品和 shell cache 限制见 [Native owner](../../../../apps/desktop/docs/native-release.md)。

## Decision

Native 包含真实 Electron、main/preload/renderer 和完整新 Terminal。outer 与 inner 独立完整核验、分别持 SH；Main、配对 Service 与共享 Daemon 各自保留两 root 使用权。服务私有 proof 只接受已核 inner 清单的 service/daemon，均固定包内 Bun、Native build 和 outer digest；遗漏 daemon 会使正确 Native 共享启动被拒绝，接受任意入口则破坏准确进程身份。2026-10-06 已补齐该 daemon 校验，不去掉 proof 或改用仅保护 inner 的 Terminal 身份。Node 传给 Bun 的 inherited descriptor 副本只 close，不执行共享描述的 UNLOCK，原 owner 与最后持有者退出分别验证。

卸载先在安装 EX 内发现封闭管理结构、准确候选集合和 outer/inner 真实目录，再稳定取得所有候选双 root EX；busy 在完整制品读取前拒绝。全部 EX 持有后完整核原候选，删除前复核 active/previous 与候选集合；保原 nonce CAS、rename/fsync 和租约清理。候选同时使用中且内容损坏时先报 busy，空闲后仍拒绝损坏。完整校验与最终结构复核分别覆盖内容身份和删除集合，不依赖缓存；合作进程持锁，不新增对同用户绕过锁写入的保证。

Native 安装可显式向合法独立 Terminal prefix 登记。两个 prefix 以固定顺序持 EX，封闭 0600 metadata 保存双方 prefix、candidateId 与 nonce。标准前门先持原 Terminal SH，再核双方 nonce、Native active、manifest 和双 root SH，实际执行 Native 包内 Bun 与固定 CLI/TUI；同一闭包提供 Service。坏登记直接拒绝，不发现其他候选或源码 fallback。

更新/回滚只修改自己仍持有的登记，卸载以原 nonce CAS 撤销；另一个 Native 后写的登记不能被旧卸载删除。撤销后仍存在的独立前门恢复 Terminal。显式 source/candidate 选择不读取登记，也不重新绑定冷原意图或活动 Run。

回退沿同一双 EX 固定仍存在且原 nonce 相同的 Terminal，完整预检必须先于 Native active 发布；最终登记仍独立复核。原先先切 active、再核目标会在预先损坏时留下 active 与双方登记失配，即使修好字节也使原前门拒绝。前置预检保三份原字节和原选择，修复后用户可先沿原前门读取，再明确回退。缺失目标的独立回退和其他 Native 的 nonce 归属保持；这不替代多文件发布中断的恢复，也不承诺跨 prefix 崩溃原子性。实际合同及有限损坏反例归[Native owner](../../../../apps/desktop/docs/native-release.md#标准命令登记与卸载恢复)。

独立 Terminal 正常卸载后，反向登记只保留历史归属，不成为 Native 后续升级的必需安装依赖。省略 cliPrefix 时只在历史目标实际存在的情况下锁定、核验并按原 nonce 更新；缺失时仅持 Native 安装 EX，继续原候选核验和 active 发布。该次锁定目标固定用于最终写入，避免缺失后重建的目录未经锁定获得自动登记。显式目标、仍存在的隐式目标和悬空链接继续原拒绝／核验路径；需要独立前门时明确重新安装并登记。保留反向记录可核原归属，不授予后来目录新的写权限。

真实代码兼容验收使用固定旧源码的原 Terminal/Native builder；不把当前 builder 配旧 inner、改 productVersion 或当前代码自造旧库当两版 Native。旧 Native 构建须在旧源码删除前完成；打包后产品只能使用物化候选的闭包。2026-10-07 已沿正式 installed 窗口完成本机 A→B→A→B，原 Core format 1/Native DB7 与数据保留、完整 B 正文和后续实际工作分别证明。该选择补齐兼容验证输入，不改变安装、回退或 trust 语义，也不把冷 caller 记录提升为新的进程内输入绑定。

普通文件完整 SHA 现由 Service 的同步 file-hash leaf按原匹配大小读取：不超过64KiB的文件保留原readFileSync全文SHA，较大文件逐块读至EOF，每次完整核验按需分配并复用一个1MiB buffer；manifest原字节摘要、完整inventory和内容身份继续执行。Main初次核验不持SH，取得双SH后必须重新完整核内容；Service仍以自己的双SH独立核完整候选。缓冲区减少大资产整份读取分配，不构成路径／mtime缓存，也不复用跨租约或跨进程的内容准入；对绕过SH的同用户并发写者不增加原子读取或绝对内存上限保证。当前实现和必要多块／短尾、两层同大小末字节拒绝证据归 [Service owner](../../../../apps/service/README.md)，实际启动与完整默认结果归[本轮进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09普通启动完整回归与制品读取)。

共享UI的Desktop浏览器产物现仅内联唯一静态核心图标包，保持原exports、CSS、React peer与其他npm external。该包原12072文件使三次全量校验重复物化浏览器已使用的资产；生成JS扫描拒绝残留external后，生成UI manifest与复制器只去除该workspace的已内联普通dependency，其他真实解析边保留。准确原许可与固定来源进入完整inventory；不按后缀裁剪资产、不缓存内容或省略任一次准入。构建owner及实际完整默认结果归[UI](../../../../packages/ui/README.md#原桌面展示层)与[本轮进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09普通制品图标依赖收束)。

## Alternatives considered

- 只把 Native CLI 可执行路径写入前门：不足以核 runtime/Service 和完整依赖；改为准确 outer/inner、nonce 与 active 的闭合身份。
- 运行时用 PATH 或当前开发产物补依赖：会使真实执行与被核制品分离；前门使用固定 Native 内 Bun 和入口。
- 卸载无条件删除登记：会撤销后来其他安装的选择；采用原 nonce CAS，并在真实双安装更新中核反例。
- 让继承 Bun helper 对共享锁调用 UNLOCK：会释放 Node Main 仍需要的使用权；helper 只关自身副本，独立 holder 全部结束后才取得 EX。
- 完整校验候选后才尝试使用 EX：使使用中的实际 Electron 在拒绝卸载前被重复读取，本机有限诊断四次 busy 合计9.204s，原完整默认因此触发45秒 driver 期限。改为结构核准后先取得全部 EX、随后完整校验并复核集合；没有采用放宽期限、移动升级/回滚出原窗口或提前安装第二候选。
- 为已缓存的 Native-bin 路径保留 stub 或修改 shell RC：扩大卸载副作用，且无法清除父 shell cache；保留准确 `127` 结果，明确 `hash -r` 或新 shell 的恢复操作。

- 用初始digest或metadata缓存跳过Main双SH后复核、让Service接受Main的验证声明：初始核验与后续使用之间有真实async租约空档，独立Service也没有可信内容证明传递；保留三次各自完整核验，以小文件原读取与大文件共享buffer减少分配，同时保完整内容验证。没有采用放宽原启动期限或缩减清单。

## Consequences

实际 fresh 组合核两种 PATH CLI 与真正 80×24 TUI，三个原 Command→Run 均 completed、Provider 三次；公共 Store、原 scope/bytes/cursor、busy 卸载、坏 nonce 与撤销后独立前门恢复分别核实。完整 Native archive/install 还在源码外删除原候选后启动 Electron Main 与所属 Service，核在途旧版本、cold 零调用、双锁故障、回滚/卸载及原数据 hash。

2026-10-06 完整 Native 源外安装 stdin 实测1项39断言核共享Daemon、无效答案/EOF保持原卡、新CLI以原Work回答一次、Provider/历史完整语义及重复零新Run/Answer。启动CLI退出与原Run完成后卸载仍busy，实际stop/status absent后卸载成功；producer原校验3项35断言分别拒绝CLI/错runtime/build/proof。该补充不包含Daemon冷重启或Electron窗口。

2026-10-06 [有限卸载反例](../../../../tests/isolated/unified-agent/native-install.test.ts)核真实 inner SH+坏 manifest 时 busy 优先、部分 outer 租约释放、释放 holder 后空闲完整性拒绝、原 active/内容保留及两层目录 alias。原源码4pass/1fail，修复后5pass/51assert/0fail；有限夹具只证明锁和格式合同。[实际安装窗口](../../../../tests/isolated/unified-agent/native-install-lifecycle.test.ts)保原45秒、原安装/升级/回滚/数据和准确退出断言，整体结果按[当前进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)的实际窗口记录；单项绿色不覆盖完整默认或平台资格。

父 shell 缓存 Native-bin-first 路径并删除安装后，原缓存返回 127；独立前门本身缓存仍可按登记撤销恢复。安装器不修改 PATH/RC，不控制用户进程或数据。Linux arm64完整安装及本地真实代码冷回退已有有限实测，平台前驱与原源码理由归[平台前驱决定](../testing/2026-10-07-platform-real-code-predecessors.md)，准确范围仍以Native owner为准。Windows安装、Linux x64/Windows Native lifecycle、新的signal fault、真实已发布predecessor、signing/公证/发布者认证仍缺对应资格。manifest/archive SHA 只证明完整性，不证明 publisher。

本决定补充[终端生命周期](2026-10-02-terminal-bundle-lifetime.md)，不改变 Profile/业务 Store 的准入权，也不宣称完整 §35 完成。
