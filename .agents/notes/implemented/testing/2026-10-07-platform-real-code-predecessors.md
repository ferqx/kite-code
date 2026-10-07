# Agent Note: 按平台固定真实代码前驱

Status: implemented

## Problem

真实升级与冷回退必须让两个原始源码各用自己的 builder 生成可启动候选，并通过已安装入口继续原数据。固定 macOS 前驱的原 SQLite 来源集合只有3.51.3/3.53.4；Linux Bun1.4.2实测 builtin3.53.2，原 builder 在任何业务派发前准确拒绝。改写旧来源检查会使“原始前驱”失真；只改版本文字又无法证明实际代码兼容。

当前要求和完整合同归[Terminal owner](../../../../apps/cli/docs/terminal-release.md#验证边界)、[Native owner](../../../../apps/desktop/docs/native-release.md#linux-真代码升级与冷回退)与[发行约束](../../../../docs/active/release-control.md)。本决定只管理本地比较输入，不改变产品的宿主Shell、安装、信任或回退行为。

## Decision

[物化夹具](../../../../tests/fixtures/unified-agent/terminal-predecessor.ts)在macOS保留原提交3140fe6d37131050033c66ffd9637fe7cd967da9；Linux固定首次已接受准确3.53.2来源的原提交1b796e30ab0f3638767095d86d4afd374eae662a，不开放调用者任意选择前驱。两者均核相同锁文件、根与八workspace清单、补丁和Core format1 SQL；依赖镜像保准确已安装字节与原workspace源码，旧builder仍核闭包。原源码构建前后必须干净；旧Terminal/Native都在删除旧源码前完成，成功后搬迁并删除全部原输出。准确commit/platform/来源/候选/hash随实际结果登记。

Terminal与Native都要求包内Agent代码字节实际变化、候选身份不同和完整已安装A→B→A→B数据链。macOS的两个原Main/renderer差异断言保留。Linux前驱较新，本轮生产变化为Agent worker的原生写锁等待；Main制品hash不同，renderer相同。Linux新增资格不声称renderer逻辑变化已验收，也不以假前端改动制造差异。

Native使用候选manifest中的实际Electron入口、明确Node ESM、平台ps argv与准确父PID；四次窗口显式开启并检查Chromium sandbox。原360/420秒整例、30秒命令、120秒Native driver及15秒窗口上界保留。release candidate明确调用三项整文件命令：POSIX Terminal、macOS Native、Linux Xvfb Native；Required unit仍完整发现并有显示环境。guard拒绝关闭、错平台、echo、过滤和缺显示。

## Alternatives considered

- 在Linux照搬3140前驱与当前官方Bun：原完整测试实际在sqlite_release_identity_invalid失败，不能启动兼容链。保留失败并选择原始、已准入Linux来源的固定前驱。
- 改旧SQLite白名单、预加载另一引擎或替换旧builder：会违反原源码与来源身份，未采用。
- 只换旧官方Bun以保3140来源集合：明确试验的官方Bun1.3.12内置3.51.2，也不在旧集合；没有持续版本猜测或修改根运行时/依赖。保当前1.4.2和准确已准入原源码。
- 只改productVersion或给当前Native配旧inner：只能证明指针或混合闭包，不能证明两份原始代码；保原两层builder与实际Agent差异。
- 删除Mac前端差异断言或给Linux造假renderer变化：缩减既有Mac资格或虚构演进；仅新增Linux范围，记录实际字节关系。
- 把Docker验证容器接入默认Shell：用户明确保留macOS宿主工具链和广泛只读宿主视图，容器仅作独立验证。

## Consequences

Linux arm64的完整Terminal文件actual0/336条Bun断言/60.741秒，完整Native文件actual0/374条Bun断言及窗口断言/171.298秒，四次普通退出结束于driver80.070秒。原Store/Command/Run/Model/caller、352041字节B全文/hash/ref、冷GET游标/Provider及回退后的新上下文保持；双层lease与Core/Native数据库inode/bytes/config、最终卸载保数据均核实。失败输入、原日志与修正归[进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07linux-真实代码升级与冷回退)。

本地比较使用HEAD加当前dirty实现，不是clean发布或已发布predecessor/T029；manifest/archive SHA仅证明完整性。Docker VM原生arm64结果不替代GitHub-hosted Ubuntu x64、Windows、四Auth/Vault、默认宿主Shell、正式持续负载或完整§35/T/E。工具线程额度拒绝新的独立Reviewer，本轮root自检不替代它。37能力保持partial、wholeV13=false，完整默认回归及正常Git门禁在实际交付范围另行登记。

本决定补充[Native闭包取舍](../architecture/2026-10-04-native-complete-closure-and-cli-registration.md)，不替代其两层使用权、原nonce CAS及数据保留理由；macOS原比较输入和断言仍适用。
