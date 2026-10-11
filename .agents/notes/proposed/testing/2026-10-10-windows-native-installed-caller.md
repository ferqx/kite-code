# Agent Note: Windows Native 正式安装完整调用者

Status: proposed

## Problem

Windows managed Native已实现稳定前门、实际创建证书和完整候选准入，但release matrix只有build／verify／smoke；安装窗口整例仅运行POSIX。该缺口妨碍实际用户安装、版本选择、维护恢复与卸载的原生验收。已有平台Shell／RSS／观测门禁不构成这条独立源码接线的前置，也不能被它替代。

## Proposal

当前已接[正式caller](../../../../tests/fixtures/unified-agent/windows-native-installation.qualification.ts)和mandatory CI步骤，实际Windows资格尚未取得，因此保proposed。只使用已核候选和零参数 `kite-desktop.exe`，Windows系统UIAutomation操作真实页面／默认菜单；原Job成员HANDLE／FILETIME／完整映像核Main／Service归属和实际退出，PPID只是已证成员的定位信息。fixture清理不得冒充普通退出，要求原Job未请求Terminate。公共MCP语法继续投影原字段。

2026-10-11扩展真实代码分支，由[统一入口](../../../../tests/fixtures/unified-agent/windows-cross-version.qualification.ts)一次物化原837a2b8c源码的两类候选，供独立Terminal与Native用户链；来源决定补充[平台前驱Note](../../implemented/testing/2026-10-07-platform-real-code-predecessors.md)，不替换其POSIX原输入／守卫。Windows前驱已具原安装builder与DB9，当前11项锁输入中10项逐字相同，根清单只接受已提交 stdio CI 脚本准确单行增量并保存双方SHA；Core baseline逐字相同，不套用POSIX source-entry例外。两版保原0.1.0但actualAgent字节与candidate不同，旧source自身build port参与自己的builder；不修改旧代码／manifest或注入当前产品helper。

## Alternatives considered

- 直接复用Playwright Electron launch：现有fixture加入user-data-dir，Windows正式前门拒绝附加用户参数；不能删除guard或增加产品调试参数来让验收通过。
- 只运行Electron version／SQLite smoke或模块mock：没有真实输入、结果、窗口退出和恢复冷读，不能关闭用户安装链。
- 系统UIAutomation与原Job观察：使用现有稳定前门，不扩大产品启动参数；代价是辅助功能树、菜单pattern和实际交互桌面必须由Windows运行证实，缺失时失败而不availability skip。

- 将原同代码标签B计为跨代码完成：只覆盖版本指针，保其独立默认链和原断言，新分支使用两份原代码。
- 将POSIX DB7前驱及两处清单例外直接套Windows：原输入不具完整Windows builder／安装能力；选择确有原实现、当时11项锁定输入逐字相同的837a2b8c；后来CI脚本的准确增量由共享纯matcher识别，其他输入保持。代价是该前驱已支持DB9，不能取得DB9拒旧样本资格。
- 向旧制品补当前model-output模块，或增大所有短正文以强制sealed：会改写候选或绕过普通完整结果。Terminal通过候选公开Runtime读取完整plain／sealed，Native按原Store事实分别核完整短正文或原sealed引用；不添加产品导出。

## Acceptance criteria

默认分支归档／解包自己的副本、删除构建副本后，A完成实际任务，运行中选择B仍固定原A；自然退出后B冷读、rollbackA再冷读。B只为同代码合成manifest版本，真实跨代码兼容另由显式分支验。全部原owner退出与两候选双EX后，installed CLI backup／inspect／restore新Store／status，再新Native窗口读取完整原结果，准确原Command／Run／Execution／sealed引用保持，Provider恰1。最终唯一卸载保Core／Native DB／config完整字节。基础120秒和独立维护180秒、各driver45秒／操作10秒预算保留，原POSIX整例不变。CI拒绝步骤删除、错平台、命令替代、忽略错误及早于build／verify／smoke。

显式predecessor分支另验A→B→A→B四基础窗口／三次明确任务，后继Provider请求包含此前完整正文，原Store／Command／Run／Execution／出处和冷游标零重放；随后B installed CLI恢复新Store和第五冷窗口／唯一卸载保数据。基础420秒、各独立driver45秒／操作10秒、维护180秒／CLI30秒均不重置或忽略统一绝对截止。独立Terminal沿稳定CLI三任务与冷context read，B352041字节完整正文进入回退A新模型请求；普通短输出保plain，长输出核原sealed／全文／bytes／hash。统一1140000ms含原源码物化180秒、Terminal360秒、Native420秒和维护180秒／收尾；原30分钟release job不放宽，三个已有Windows caller保持并位于新mandatory步骤之前。源码检查／macOS实际读取不算Windows整链通过。

## Risks

本机macOS只能验证控制流、公共投影、CI守卫和类型；Windows UIA树自动启用、菜单、嵌套Job、DACL／真实两跳证书及维护正向链未执行。保现有Shell guard、原RSS红和完整资源观测门禁，不宣告阶段退出。执行顺序和有限证据归[当前进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10windows-native-正式安装版本切换与维护调用者源码)，完整当前边界归[Native owner](../../../../apps/desktop/docs/native-release.md#windows-managed-native-当前实现)。
