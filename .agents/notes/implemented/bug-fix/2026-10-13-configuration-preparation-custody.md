# Agent Note: 配置准备失败的资源交接

Status: implemented

## Problem

正式任务和恢复在配置返回前可能已经取得实际资源。原准备错误与disposer错误同时出现时，Service只抛普通Error/cause，Runtime只保存Command拒绝原因；配置尚未返回，Runtime没有disposer，也没有强资源持有或cleanup gate。返回配置后验证／SQL启动失败时，disposer异常还可能覆盖原错误。既有恢复布尔门禁阻关闭，但不能单凭bool证明原配置对象仍被持有。

默认Service已注册正式Files，临时assembly仍打开另一Workspace目录owner；只有未提供externalFiles的standalone分支消费它。这份无消费者的重复资源应消除，不应为制造失败测试保留。

## Decision

当前实施：Agent提供可信ConfigurationPreparationCleanupError，非枚举cause保原准备错误、cleanup错误和实际resources引用。五个resolver接收点只认该明确类型；普通配置拒绝不升级为未知。返回配置后清理失败由准确接收者构造同类型；原disposer只调用一次，失败结果缓存，不在shutdown重试。

原配置清理预约集合保强引用，单一准备清理失败事实参与现有lifecycle busy/drain门禁，不伪造Run ID或另建全局任务注册表。三类恢复继续保原lease／owner和准确失败事实。Service只交接assembly／scope和错误，不拥有权限或资源清理策略。默认外部Files装配不再打开第二目录owner；standalone真实Files仍保原功能及关闭权。

## Alternatives considered

- 从任意Error.cause猜资源：没有可信交接契约，也可能把普通错误升为资源authority。
- 伪造Run lease或新增全局资源registry：准备时尚无实际Run身份；已有清理owner足以保失败资源。
- 重试disposer或仅保cleanup bool：前者可能重放未知关闭，后者不能证明资源仍被强持有。
- 保默认重复Files再写故障窗口：无现行消费者，应先消除；验收使用仍支持的standalone装配或可信准备回调。

## Consequences

普通配置拒绝仍可正常关闭；实际准备／清理双失败保原错误、资源、Profile使用权及恢复lease，关闭失败不能当实际进程退出。完整验收从Service／Client原Command开始，核真实Files原目录内容、零新Model／Run／Execution、活进程维护busy；测试自己child实际退出0和双EOF后才允许公开备份及完整原数据冷读，零重放。各接收点另由相关完整Runtime／child／resume／report／Job回归核正常行为及准确清理。

当前来源与承诺归[Runtime owner](../../../../packages/agent/src/lifecycle.README.md)、[Service owner](../../../../apps/service/README.md)、[取消与恢复](../../../../docs/handbook/features/recovery.md)。该决定不解除全resources／handles／出生后代、RSS、Win/Linux或阶段资格，不添加参数对照矩阵；本轮只本地提交，不push／PR／Actions。

默认重复owner删除前后原完整assembly5／34／0，正常文件工具消费者由原owner负责，不声称性能量化收益。正式Service返回前真实目录准备／清理双失败，原red收据显示Model0／closeAttempts1、原目录完整可读，但Service／Runtime error均null且closed；typed接线后整例1／31／0，原必选Skill与原cleanup对象保持，实际自己child退出0及双EOF后才准公开backup／完整冷读。返回配置后的失败／健康与child返回前失败完整文件3／58／0；child父Model1、子Model0、父Tool unknown，无child Session／Run／Job和后续Model，实际Files及Profile仍保。

必要原完整24文件120／1723／0、40.041秒，3876输入零漂移；其后只改新测试文件增加child验收，完整新文件重跑3／58／0，23个未变相关文件结果精确复用，最终24文件121／1744／0。准确freeze／逐文件原log／current-result位于 `/private/tmp/kite-preparation-custody-final-targets-20261013-*`，current-result SHA 32816a7e7e4f0a8b4d786aa5bb0da743baa486b0da72f9088f4e943b150e42ea。真实Electron40效果、零取消、四次读取拒绝而无quit弹窗／page error／观测错误；Electron与原Service PID23410正常0、无信号。它不证明截图原安装包身份。

原child／三类恢复完整回归与独立源码审查支持现行配置、freshness、后置disposer失败及原lease合同。后续[三个显式恢复入口](../../../../apps/service/test/isolated/recovery-preparation-ownership.test.ts)已从正式 SDK 直接验证新 typed 返回前实际 Files 清理失败：保原两错误、准确实例和一次关闭，关闭拒绝后独立 Store 仍不能取得原 Session owner；原业务数据与 accepted／null 恢复 Command 合同保持。活进程维护拒绝，所属进程实际 0 与双 EOF 后才允许公开备份和完整冷读零重放，准确范围归[恢复交接进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-13显式恢复准备失败的维护交接)。其余瞬时I/O失败owner、完整resources／handles／出生后代、原RSS及三平台／阶段门禁不变。旧Worker Note对未交接准备cause的限制在此次明确类型范围内部分替代，原Mach／SQL／Web所有权与未知资格理由继续适用，见[原Note](2026-10-13-owned-worker-termination.md)。具体原red、最终核验和独立审查归[当前进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-13配置准备清理与正式维护交接)。

同源项目／Skill／Workflow 的实际文件读取关闭失败后续沿[知识资源决定](2026-10-13-knowledge-read-custody.md)补齐准确作用域、Run 与任务外目录交接；它只部分收束上述瞬时 I/O 限制，不替代本 Note 的 typed 接收者与其余资源／恢复／平台门禁。
