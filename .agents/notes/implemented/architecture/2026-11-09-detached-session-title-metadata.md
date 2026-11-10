# Agent Note: 独立命名 Job 与原子标题元数据

Status: implemented

## Problem

用户要求 AI 命名与首轮并行，且不延迟启动、正式完成或下一轮。完成前 Action 等待远端模型、共享业务模型槽和公共 rename 推进控制修订，分别引入执行围栏、槽等待和无关输入失效。只把旧 Action 改成不 await 不能解除这些依赖，也不能监督未知调用和真实资源。

## Decision

默认 beforeRun 短 Action 只保存原文 fallback、claim 唯一意图并登记一个受管 detached Job。Job 在准确原 Run 激活并封存配置后独立生成，不等待首个业务 Model 派发；模型退出后释放槽、配置和 transport，再轻量等待原 Run 成功，在同一个 Job 内 CAS 发布或关闭。主 Run 的完成条件、必要结果、取消和最终事务保持。命名不是子 Agent，没有新增发布 Action、通用 dispatcher、continuation 或投递 lease。当前职责与验证归[Agent](../../../../packages/agent/README.md#入口与职责)和[Service](../../../../apps/service/README.md#生命周期性能测量)。

私有记录使用独立 `automatic-title-attempt` key、contentType 和版本1，旧 `automatic-title` 保持原解释。fallback、发布分别原子保存标题、原收据和 record，不推进执行 controlRevision；公共手动 rename 保持原 CAS 和递增。公共／自动入口不能跨 namespace 复用同 ID 收据。发布核原 default Job、fallback Action、operation key、首 Run、完整 Model 结果及 record revision，手动同名 ABA 核准确 rename Command。完整 bounded 正文保留在原 Model 结果，正文和 reasoning 不复制到 marker。同一纯来源解析供异步 factory 与同步最终事务使用，保公开输入、决定和澄清链的准确身份。具体事务归[Storage](../../../../packages/agent/src/storage/README.md#session-标题写入)。

只有完整准确来源的默认命名 Job／Model 取得局部未知收口；普通 detached Shell、兄弟 Job、空工具目录或自报 purpose 不获豁免。原发布只提交一次：已提交时读同事务原收据；原请求仍可能提交时查空只继续观察；仅在 Worker 确认原请求结束且事务未提交后关闭尝试。结束证据来自实际 `assertRequestSettled`，私有错误 WeakSet 经 Worker 交接，不信任错误自报属性。真正 Store、owner、共享完整性和读取故障仍失败关闭。冷读取不启动命名；准确失主恢复资格才能关闭旧尝试，不借新 Store 或后来的 Run 发布。

按本机正常／突发测量固定独立标题并发为 `min(modelConcurrency, 4)`，每许可最多7个等待，默认28，排队8秒；实际调用从 Provider 入口另计原10秒取消预算。输入副本最多8192码点，输出保32KiB完整界和最多10码点标题校验。标题先完成就释放生成资源，Job等待不占模型槽。容量或排队超时保 fallback，不自动重试同一尝试。模型配置复用准确原封存身份，重新核当前凭据及宿主 ceiling，不缓存授权或借用已释放的业务 lease。

默认标题的完成前等待、公共 rename CAS 与共享业务槽部分替代[生命周期 Action 决定](2026-10-18-run-lifecycle-extension-actions.md)和[内部 Model 决定](2026-10-22-internal-model-calls-without-child-agents.md)。通用钩子、扩展承担业务、原 Session 内部 Model、完整输出、准确取消和真实资源 drain 的原理由仍适用。

## Alternatives considered

- 主 Run 成功后才开始生成：解除完成依赖，但失去用户要求的首轮重叠。
- fire-and-forget 原 generate Action：仍受普通 Action 围栏影响，也丢失资源／owner 监督。
- 候选 dispatcher、独立发布 Action、pending-effect lease：为同一效果增加权威和交接；一个已登记 Job 已能覆盖生成、等待和发布。
- 自动 rename 沿公共 controlRevision：把标题元数据混入执行 CAS，影响输入，也会因无关引导废弃候选。
- 用完整执行修订或标题相等判断手动改名：分别引入无关失效或同名 ABA 漏洞。
- 只核 Model 流式前缀：尾部内容可能使完整标题无效；保原完整结果和收据比增加候选正文副本更小，也保留输出 digest 规则。
- 泛化 detached／runless 豁免：会让未知 Shell 或伪造用途绕过恢复围栏；资格必须来自准确原记录及实际调用链。

## Consequences

主 Run、下一轮和 Native 执行终态不依赖标题。生成未知、未确认发布和 disposer 故障在命名域保留；真实资源未退出前仍由宿主监督。paired CLI 开始关闭时取消未完成命名并保 fallback，不为标题另建 daemon，也不假装释放不合作的 Provider。独立额度只消除本地业务模型 FIFO 等待，不承诺远端限流或共享 CPU、Store、磁盘零竞争。

底层只读 Job 目录保留原内部执行用于诊断；普通 Native 环境按准确 Shell／child 来源投影，不把命名列作业务后台任务。原历史和旧 marker 保持可读。旧 HEAD readonly Store 对7个新记录及原 Run／Execution 的兼容性实测中，原数据库字节、数量和 cursor 未变；此证据不授予旧 Runtime 接管活动新 Job 或直接降级写入的资格。

开发验证、故障组合、负载预算、进程冷启动与可见 Native 全过程的实际范围分别归 Agent、Storage、Service 和[Desktop](../../../../apps/desktop/README.md#执行观察与操作准入)。原全量失败和未取得的千次耗时、平台、安装版、远端模型、OS最终合成及私有CDP重载资格保留，不由定向通过覆盖。用户已排除TUI；其未提交候选不属于本决定的交付。新的实际失败、相关变更或有依据风险再按原验证细则核受影响结论，不以阶段切换重复全部验收。
