# Agent Note: 按依赖输入和平台固定真实代码前驱

Status: implemented

## Problem

真实升级与冷回退必须让两个原始源码各用自己的 builder 生成可启动候选，并通过已安装入口继续原数据。早期固定 macOS 前驱的原 SQLite 来源集合只有3.51.3/3.53.4；Linux Bun1.4.2实测 builtin3.53.2，原 builder 在任何业务派发前准确拒绝。复用 PC 展示层后 bun.lock 已变化，原 macOS 3140／Linux 1b796 输入不再满足相同依赖守卫，Mac 原作业实际在 bun.lock 被拒绝；旧资格不能沿用到变化后的输入。改写旧来源检查会使“原始前驱”失真；只改版本文字又无法证明实际代码兼容。

当前要求和完整合同归[Terminal owner](../../../../apps/cli/docs/terminal-release.md#验证边界)、[Native owner](../../../../apps/desktop/docs/native-release.md#linux-真代码升级与冷回退)与[发行约束](../../../../docs/active/release-control.md)。本决定只管理本地比较输入，不改变产品的宿主Shell、安装、信任或回退行为。

## Decision

[物化夹具](../../../../tests/fixtures/unified-agent/terminal-predecessor.ts)当前固定复用原 PC 展示层后的 DB7 原提交 a2b6441fde28d9c0f895a26e6a9d2471d2b1b242，不开放调用者任意选择前驱。macOS 的3140fe6d37131050033c66ffd9637fe7cd967da9与Linux首次接受准确3.53.2的1b796e30ab0f3638767095d86d4afd374eae662a仍保历史输入和拒绝理由。当前前驱核全部11项相同锁文件、根与八workspace清单、补丁和Core format1 SQL；依赖镜像保准确已安装字节与原workspace源码，旧builder仍核闭包。原源码构建前后必须干净；旧Terminal/Native都在删除旧源码前完成，成功后搬迁并删除全部原输出。准确commit/platform/来源/候选/hash随实际结果登记。

Terminal与Native都要求包内Agent代码字节实际变化、候选身份不同和完整已安装A→B→A→B数据链。macOS的两个原Main/renderer差异断言保留。历史Linux 1b796组合的生产变化为Agent worker原生写锁等待；当时Main制品hash不同、renderer相同，只记录实际关系，不造假前端变化。当前a2b6441f的Linux组合尚未执行，依用户顺序在重构完成后由GitHub Actions验证；历史结果不为它授予资格。

Native使用候选manifest中的实际Electron入口、明确Node ESM、平台ps argv与准确父PID；四次窗口显式开启并检查Chromium sandbox。原360/420秒整例、30秒命令、120秒Native driver及15秒窗口上界保留。release candidate明确调用三项整文件命令：POSIX Terminal、macOS Native、Linux Xvfb Native；Required unit仍完整发现并有显示环境。guard拒绝关闭、错平台、echo、过滤和缺显示。

## Alternatives considered

- 在Linux照搬3140前驱与当前官方Bun：原完整测试实际在sqlite_release_identity_invalid失败，不能启动兼容链。保留失败并选择原始、已准入Linux来源的固定前驱。
- 改旧SQLite白名单、预加载另一引擎或替换旧builder：会违反原源码与来源身份，未采用。
- 只换旧官方Bun以保3140来源集合：明确试验的官方Bun1.3.12内置3.51.2，也不在旧集合；没有持续版本猜测或修改根运行时/依赖。保当前1.4.2和准确已准入原源码。
- 只改productVersion或给当前Native配旧inner：只能证明指针或混合闭包，不能证明两份原始代码；保原两层builder与实际Agent差异。
- 为沿用历史提交而忽略新的锁文件，或给旧源码注入当前页面：会使两个候选混入不同依赖或改写历史输入。选择真正已提交、依赖完全相同的PC展示层后DB7源码，全部守卫保持。
- 删除Mac前端差异断言或给Linux造假renderer变化：缩减既有Mac资格或虚构演进；仅新增Linux范围，记录实际字节关系。
- 把Docker验证容器接入默认Shell：用户明确保留macOS宿主工具链和广泛只读宿主视图，容器仅作独立验证。

## Consequences

历史Linux arm64 1b796组合的完整Terminal文件actual0/336条Bun断言/60.741秒，完整Native文件actual0/374条Bun断言及窗口断言/171.298秒，四次普通退出结束于driver80.070秒。原Store/Command/Run/Model/caller、352041字节B全文/hash/ref、冷GET游标/Provider及回退后的新上下文保持；双层lease与Core/Native数据库inode/bytes/config、最终卸载保数据均核实。失败输入、原日志与修正归[进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07linux-真实代码升级与冷回退)。

当前macOS a2b6441f组合的完整Terminal文件actual0／1pass／336断言／249.85秒，完整Native文件actual0／1pass／513条Bun及driver断言／320.79秒。第四B窗口原侧栏惰性产生DB8 unknown申请，原四窗口于94.968秒内完成；随后同一已安装候选再完成两个独立冷窗口。旧DB7 Native明确拒绝私有操作且保原bytes／inode，兼容Core三条历史仍完整GET；切回当前版才明确原GET查回，Provider仍3，六Service普通退出、双EX及最终卸载保数据。私有原字节在明确查询前保持，查询只保存原申请结果；不自动恢复数据。原420／120／15秒定义保持，新冷段独立60秒；两段最终只卸载一次。原锁输入、页面标记、重复安装导致整例超时及跨桥Error属性的真实失败均保留，准确范围归[当前进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08native-db8-真实代码回退)。

本地比较使用HEAD加当前dirty实现，不是clean发布或已发布predecessor/T029；manifest/archive SHA仅证明完整性。Docker VM原生arm64结果不替代GitHub-hosted Ubuntu x64、Windows、四Auth/Vault、默认宿主Shell、正式持续负载或完整§35/T/E。本次新的只读Agent被线程上限拒绝，未取得整片独立审查，root自检不替代它。37能力保持partial、wholeV13=false，完整默认回归及正常Git门禁在实际交付范围另行登记。

本决定补充[Native闭包取舍](../architecture/2026-10-04-native-complete-closure-and-cli-registration.md)，不替代其两层使用权、原nonce CAS及数据保留理由；原始源码、引擎准入、依赖和macOS前端差异断言仍适用；旧固定提交仅保其历史范围。
