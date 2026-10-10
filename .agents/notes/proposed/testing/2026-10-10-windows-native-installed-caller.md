# Agent Note: Windows Native 正式安装完整调用者

Status: proposed

## Problem

Windows managed Native已实现稳定前门、实际创建证书和完整候选准入，但release matrix只有build／verify／smoke；安装窗口整例仅运行POSIX。该缺口妨碍实际用户安装、版本选择、维护恢复与卸载的原生验收。已有平台Shell／RSS／观测门禁不构成这条独立源码接线的前置，也不能被它替代。

## Proposal

当前已接[正式caller](../../../../tests/fixtures/unified-agent/windows-native-installation.qualification.ts)和mandatory CI步骤，实际Windows资格尚未取得，因此保proposed。只使用已核候选和零参数 `kite-desktop.exe`，Windows系统UIAutomation操作真实页面／默认菜单；原Job成员HANDLE／FILETIME／完整映像核Main／Service归属和实际退出，PPID只是已证成员的定位信息。fixture清理不得冒充普通退出，要求原Job未请求Terminate。公共MCP语法继续投影原字段。

## Alternatives considered

- 直接复用Playwright Electron launch：现有fixture加入user-data-dir，Windows正式前门拒绝附加用户参数；不能删除guard或增加产品调试参数来让验收通过。
- 只运行Electron version／SQLite smoke或模块mock：没有真实输入、结果、窗口退出和恢复冷读，不能关闭用户安装链。
- 系统UIAutomation与原Job观察：使用现有稳定前门，不扩大产品启动参数；代价是辅助功能树、菜单pattern和实际交互桌面必须由Windows运行证实，缺失时失败而不availability skip。

## Acceptance criteria

归档／解包自己的副本、删除构建副本后，A完成实际任务，运行中选择B仍固定原A；自然退出后B冷读、rollbackA再冷读。B只为同代码合成manifest版本，真实跨代码兼容仍单独验。全部原owner退出与两候选双EX后，installed CLI backup／inspect／restore新Store／status，再新Native窗口读取完整原结果，准确原Command／Run／Execution／sealed引用保持，Provider恰1。最终唯一卸载保Core／Native DB／config完整字节。基础120秒和独立维护180秒、各driver45秒／操作10秒预算保留，原POSIX整例不变。CI拒绝步骤删除、错平台、命令替代、忽略错误及早于build／verify／smoke。

## Risks

本机macOS只能验证控制流、公共投影、CI守卫和类型；Windows UIA树自动启用、菜单、嵌套Job、DACL／真实两跳证书及维护正向链未执行。保现有Shell guard、原RSS红和完整资源观测门禁，不宣告阶段退出。执行顺序和有限证据归[当前进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10windows-native-正式安装版本切换与维护调用者源码)，完整当前边界归[Native owner](../../../../apps/desktop/docs/native-release.md#windows-managed-native-当前实现)。
