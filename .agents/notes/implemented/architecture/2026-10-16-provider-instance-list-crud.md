# Agent Note: Provider 实例列表与安全删除

Status: implemented

## Problem

协议族是新增连接的模板，不能等同于已添加的账户/端点实例。旧按端点和凭据摘要分组的连接身份会在编辑时变化；删除后复用原别名会使旧会话模型路由指向新账户。删除还涉及默认模型、本机定时引用、原命令未知结果，以及独立的系统凭据库边界。

## Decision

设置主区仅按用户声明的连接平铺列表，新增最右栏表单通过下拉框提供四类快捷模板；显示名与配置身份分离。既有用户provider alias保持原样，新增实例分配不复用的随机alias；用户模型路由仍由其alias和模型名决定。旧assembly模型第一次编辑时把原连接摘要持久化为共享connectionId，新增实例取得随机ID；名称、端点、协议和凭据更改保留模型ID。读取只做安全投影，空声明可见，不执行磁盘迁移。

Provider update沿原command/read-set/CAS与两介质回执链新增有限upsert/remove意图。删除准确连接及相关本地配置，默认引用在Service拒绝；Native在首次POST前重读本机全部定时任务与非终态运行引用并拒绝删除。Native任务保存/启用与Provider写入串行，unknown删除未明确查回前禁止新增任务引用。删除不撤销Vault秘密，也不替换会话模型或默认模型。旧会话引用缺失时应明确选择可用路由，不能由新增同名实例复活旧绑定。

所有新增/编辑/确认沿既有RightSidebar与最右host。新增不另开模板列表，列表和表单均不展示历史回执内容或内部ID；仅未知更改显示简短提示和原提交查询，内部账本及未知锁保留。草稿与其读入连接事实绑定；异步结果不能覆盖后来的表单，外部刷新不能把旧字段与新read-set拼接成有效写入。保存失败保留草稿，直接提交或查询原提交确认成功后都先刷新再关闭原面板，删除后焦点返回新增入口；身份、编辑代次与原目标核验防止晚到回执关闭后来编辑器。

本决定补充[原Provider原意图与下一次选择](2026-10-06-native-provider-intents-and-next-run-selection.md)：原Vault/JSONC事实、冷GET、活动运行冻结和权限边界继续有效。当前产品行为归[模型配置手册](../../../../docs/handbook/features/models-and-configuration.md)，实现与测试归[Desktop owner](../../../../apps/desktop/README.md#native-provider-与下一次模型选择)及[Service owner](../../../../apps/service/README.md#native-provider-与下一次模型绑定)。

## Alternatives considered

- 只隐藏四个固定卡片：没有真实实例身份/删除，无法保留同类型多个账户，拒绝。
- 用名称、地址或凭据作为可变身份：编辑会改变连接标识，或删除重建复活旧route，采用稳定随机新身份与既有alias保留。
- 删连接时自动选默认或删除Vault秘密：扩大用户确认的效果并可能影响共享凭据，采用拒绝引用与独立凭据边界。
- 重建整个用户配置格式：增加无关迁移与注释丢失风险，采用既有JSONC adapter的有限字段编辑。

## Consequences

同模板同地址可以有多个具名实例，旧配置读取不变更磁盘。删除须先解决默认/定时依赖；未决原意图仍可冷查，不能自动重发或补偿。运行历史和Vault可能保留已删除连接的旧记录，由各自明确流程处理。

[真实Client/HTTP测试](../../../../apps/service/test/isolated/provider-settings.test.ts)、[Main测试](../../../../apps/desktop/test/native-provider-settings.test.ts)、[Native串行调用回归](../../../../apps/desktop/test/native-caller.test.ts)、[DOM](../../../../apps/desktop/test/native-provider-settings-dom.test.tsx)及[Node备份恢复](../../../../packages/agent/test/isolated/maintenance/desktop-configurations.test.ts)验证各自闭合边界。Linux Electron隔离预览不外推真实远端账户、系统Vault、正式全量构建或其他平台资格；本机引用保护不锁定非合作外部JSONC编辑器。
