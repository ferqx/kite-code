# Agent Note: 同源知识读取的资源收尾

Status: implemented

## Problem

正式任务读取项目指令和 Skill 正文／资源，手动 Workflow 编译及引用读取还使用同步文件描述符。原 finally 关闭异常会覆盖读取异常，随后目录、编译或取消 catch 将其降为普通不可用，原实际 handle／fd 随局部 source 或目录映射重建而丢失。配置返回前和任务外的 `/skills` 读取尤其不能只靠成功返回配置后的 Run disposer 保住资源；Runtime 可能成功关闭并交接 Profile。

## Decision

Agent 的无 I/O factory 创建一个知识读取作用域，只有已准入的操作可以取得实际文件资源。async FileHandle 与 sync fd 由同一 owner 在原 open 边界取得；每个资源只关闭一次，确认成功才移除，失败强保全部原资源与原读取／关闭错误。dispose 封新操作、等待已准入的完整复合读取并缓存结果；操作结束撤销其 Access。普通坏文件、版本或能力拒绝在原 close 成功后仍局部不可用。

具体项目／Skill factory 提供 disposer，可由可信宿主显式传同一作用域。Workflow compile、复核、引用、Verifier 与 Compensator 传同一 host 参数，参数不进入 ContextSources、持久 SourceRequest、编译 DTO、clone 或快照。Service 只持原作用域并装配：Run 沿已有 disposer，准备失败沿 ConfigurationPreparationCleanupError，任务外目录先等待本实例已进入的 list 再沿 beforeResourceClose 结算。目录元数据可以重建，资源 owner 独立于它；关闭未知不能进入 unavailable、普通权限拒绝或 cancelled 成功分支。

## Alternatives considered

- 只在 finally 添加 cause：仍会被外层 catch 降级，且没有向 Run 或目录宿主交接原资源。
- 只关闭当前目录 map 的 source：失败项未入 map、重复位置删除和重建会丢 owner；长期保存全部健康 source 又增加无用途的历史持有。
- 新全局资源 registry 或 Core 知识执行类别：现有作用域、Run disposer、准备失败 receiver 和 Service 读取收尾足以表达实际所有权。
- 重试 close 或重新打开原路径：未知关闭不可重放，路径也不能替代原已打开资源身份。

## Consequences

正式 Service 的任务、Skill 工具与取消、普通／手动 Workflow 目录及其关闭现在使用原作用域和既有收尾链。关闭失败保存的是原真实资源与原错误；普通输入失败仍按原合同局部处理。资源归属与 metadata Map 分离，不长期保留全部健康 source，不新建 Core 执行类别或全局 registry。Programmatic 宿主仍负责在自己的生命周期结算所传作用域；纯 ContextSources 不隐式转移资源关闭权。

原 HEAD4028 的准确公开 exports 对照在一次真实 FileHandle open／close 拒绝后，完整 Unicode／CRLF 仍可读，Command 以 skill_unavailable 拒绝、无 Model／Run／Execution，却让 Service 与 Runtime 成功 closed、原 child 仍存活。新验收在原生产代码 actual1／7expects，日志 /private/tmp/kite-knowledge-prep-before-final.log；此前依赖、别名与 fixture 合同误猜导致的失败保留为 setup／验证错误，不作为产品红。

当前 Service 完整五例 actual0／140expects：原必选 Skill 准备、实际 Skill Tool 信号取消、普通目录、manual Workflow 实际同步 fd，以及在途目录关闭。每例原资源 close 尝试一次，活进程公开维护 owner_busy；只有自有 child 实际 exit0 和双 EOF 后才备份并完整冷读原 Metadata／View／Command／Message／Execution，模型零重放。故障是在实际原 close 边界注入 JavaScript 拒绝，不能声称自然 OS API 关闭失败。

Agent 完整 owner 两例／24expects核两并发 FileHandle、两个同步 fd、原字节和两原错误、同 scope 全部资源、缓存 first failure、一次关闭、复合读取封口后完成及退休 Access 拒绝。全部新增用例使用 tmpdir／标准 file URL、无 OS skip；本机运行不授 Win/Linux 实机资格。

必要原完整28文件 actual0／112.329秒、3879输入零漂移；补齐新 Service 完整五例后精确复用该28份结果，最终29文件191pass／1965expects／0fail、3881输入零漂移，收据 /private/tmp/kite-knowledge-final-20261013-result.json。原 Workflow、权限、来源与全部旧断言／预算保持。真实 Electron 原40效果、零取消、9次真实 native_draining 读取／释放拒绝而无退出弹窗／页面或观察错误，Electron与所属 Service PID41987各exit0／无信号；不反推截图运行包身份。

当前实现与产品行为由[Skills owner](../../../../packages/agent/src/skills/README.md)、[Workflow owner](../../../../packages/agent/src/business/skill-workflow/README.md)、[Service owner](../../../../apps/service/README.md#同源-skill-知识目录)和[产品扩展说明](../../../../docs/handbook/features/extensions.md)维护。该决定仅补同源知识实际关闭失败的持有与交接，部分收束[配置准备 Note](2026-10-13-configuration-preparation-custody.md)中的瞬时 I/O 限制，原 typed receiver、Mach／SQL／Web 门禁仍适用。三个恢复新 typed 返回前实际资源交接的直接证据后续沿上述配置准备 Note 补齐；本知识读取决定及其余适用理由保持。全 Runtime resources／handles／出生后代、原 RSS、Win/Linux 及阶段资格继续保留。
