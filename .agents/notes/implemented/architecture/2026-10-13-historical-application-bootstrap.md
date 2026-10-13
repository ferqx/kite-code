# Agent Note: 历史应用导入与普通启动分开退役

Status: implemented

## Problem

当前正式入口已使用新八workspace，但旧CLI/TUI/Service仍有普通启动或构建入口。CLI/TUI和Service的同一文件也提供历史函数API；在文件末尾报退役不能阻止静态import先加载旧运行库，直接删除函数又会破坏历史导入、同步调用和私有helper用途。

## Decision

按[当前开发合同](../../../../docs/development/local-development.md)，旧普通入口只进入[无旧依赖的退役leaf](../../../../scripts/development/retired-entrypoints.ts)，输出适用的当前命令并退出2。CLI/TUI/Service原方法移至同目录legacy implementation，方法正文逐字保留；非main导入才取得其原函数对象。CLI根与subpath保持同一runCli/runTui对象；runTui和MCP判定函数仍同步，Service保原异步模块及私有helper完整等待。

CLI采用条件同步加载。首次统一条件async方案在Bun1.4.2真实bundle中产生未定义 `__promiseAll`；仅把根改为顺序await仍失败，保bundle断言后改为同步绑定才通过。Service没有据此改成未等待的后台调用。其原history／process-tree／POSIX supervisor／MCP四个private family仍由准确argv形状选择旧router，原验证／执行继续由原方法负责；混杂internal marker不取得普通App Server通路。预选只决定是否加载历史实现，不增加权限或第二业务authority。

此决定扩展[Desktop普通入口退役](../simplification/2026-10-13-legacy-desktop-entrypoints.md)的leaf，不反转其理由。历史源码、明确library调用、私有helper和已保存制品保留出处；这些保留项不成为当前正式入口或新数据写入许可。

随后沿同一边界收束旧OSS普通build／verify／installer生命周期／smoke：四个脚本普通执行只进release诊断分支。installer非main取得原五函数、常量、类型，原方法同目录保全，同步语义和prefix根／OS home不变；原smoke整脚本另保明确historical qualification，原producer库及样本不改。当前owner和完整证据归[发布边界](../../../../docs/active/release-control.md#历史-oss-工具与明确验收)。此决定只消除普通旧调用者，未将历史库标为无消费者或全树已删。

## Alternatives considered

- 保留静态re-export，只在main末尾报退役：拒绝。旧依赖先加载，缺旧依赖时诊断不能到达，且可能先进入旧初始化。
- 将历史函数变为退役stub或async代理：拒绝。会丢原函数对象、同步TUI／MCP判定、原方法和私有helper的合同。
- 所有分支条件async加载：原实现已尝试，真实bundle失败，不删除或排除其断言。
- 普通入口提前拒绝、library保原实现对象，CLI同步加载而Service保原异步／等待：采用，实际source与bundle的入口胶水通过。
- 直接删除整个旧运行库：拒绝。完整资源／RSS／平台和其他旧consumer的退出条件尚未闭合，历史用途仍需单独核对。
- 在OSS producer／installer导出内统一拒绝，或删除原smoke检查：拒绝。历史样本仍实际调用这些原方法，原检查和完整清理有保留用途，普通main可在旧加载前独立拒绝。

## Consequences

旧CLI/TUI和Service普通源码及package构建命令明确拒绝，当前完整CLI/TUI、daemon/Web和Native沿新owner；不自动迁移旧数据。新[完整测试](../../../../tests/isolated/unified-agent/retired-application-entrypoints.test.ts)核真实普通调用的诊断／数据保全，另以复制真实wrapper及无副作用历史port核source、实际Bun bundle、函数对象、同步返回和四private family；后三者不冒称完整旧OS运行资格。原方法的独立字节比对、真实红绿和未覆盖范围归[进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-13旧-clituiservice-普通入口退役与历史导入保留)。

用户本轮明确要求Web端保持现状，旧Web package及owner文档已还原到本轮开始的提交，Web不纳入本次退役；助手全文的实际系统剪贴板核对未获确认，保留原门禁并停止预览。此范围收束只撤回本轮新增的Web退役分支／验证，不改原Web回归断言。

当前仅macOS实际执行；Win/Linux后置，原Shell失败、RSS、完整观测及§35全阶段门禁保留。其他历史producer和整个旧源码树未由本片全部退役。
