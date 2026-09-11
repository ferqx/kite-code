# ADR-0181：桌面页面重接保留原生 Service protocol peer

状态：accepted
日期：2026-09-10

## 背景

用户要求页面刷新由客户端自动处理，不应要求手动清理连接，也不能为了恢复界面停止仍在执行的任务。原实现将 renderer 的 Runtime Client 与原生 stdio peer 视为同一生命周期：页面刷新后 JS 对象消失，Service 却仍持有初始化后的连接。再次 initialize 会被拒绝，关闭后重启又会触发任务清理。

## 决定

原生宿主保留同一 Service protocol peer，在其生命周期内缓存该 peer 的真实初始化结果。页面重新接入时只更换 renderer 代次，隔离请求 id、唤醒旧 receive、取消旧订阅；新的 Runtime Client 读取相同初始化事实，再沿原接口查询、订阅和加载历史。不重新发送任务命令，不改变 Service principal、工作区授权或执行 authority。

普通 App 热更新复用入口持有的 DesktopClient；完整页面刷新在宿主已有服务时自动重接。当前窗口的项目和会话导航位置使用 sessionStorage 保存，恢复时仍核对原生当前项目及 Service 会话归属。项目列表、导航位置和传输状态都不替代服务端运行事实。

## 约束与验证

不启动第二个服务、daemon 或后台重试循环，不持久化协议回执或执行队列。stdout 沿用有界队列，重接只保留初始化结果、至多一条待交付响应与当前订阅身份。显式断开、切项目和退出继续使用原有 EOF 清理；旧 renderer 代次不能关闭新连接。

原生配套服务测试覆盖初始化尚未返回时重接、取消旧 pending receive、流式任务中更换页面而服务 instanceId 不变、请求计数重置时过滤旧回执、重新订阅与读取历史；仍验证显式 EOF 清理。前端测试覆盖自动恢复选中会话且不创建或发送任务。

这不承诺恢复已退出的原生服务执行，也不增加未发送草稿的持久化。当前职责与操作说明见[桌面新对话与恢复](../../apps/kite-desktop/docs/new-conversation.md#页面刷新与连接恢复)。
