# Agent Note: 工具上下文的通用封存回执证据

Status: rejected — 新增证明字段不能成为现有统计事实的前置条件

本方案在本轮迭代内撤回，未作为最终交付。当前实现及撤回理由见[封存输入与事实一致性](../../implemented/bug-fix/2026-11-09-context-estimate-sealed-input-consistency.md)。以下为曾考虑方案与当时的局部验证，不是当前实现依据。

## Problem

用户明确要求未来新增工具自动参与主Agent与子Agent内部Loop的上下文计算，不能逐个增加格式器保留配置。前次[刷新与只读格式器决定](2026-11-09-composer-refresh-context-formatters.md)中的web_fetch保留方案只能处理已登记的Run级格式器；MCP搜索等step工具和未来工具仍依赖额外维护，不能满足此目标。该前次决定中弹层意图与门禁分离、失败退避仍适用。

## Proposal

ExecutionEngine在每次普通Model请求快照中统一记录已消费工具的私有toolResults证据：原Execution身份、稳定终态、结果revision及绑定Store／Session／Run／call／定义版本／完整结果的摘要。正文沿原模型输入封存，不复制一份正文或持久化可执行格式器。结果未知或未取得稳定回执不生成证明。

只读上下文预测按当前所选历史与工具回执重新核对证据，再复用该封存请求中已实际发送给模型的工具正文。回执或revision变化、来源／call不符、重复证据及正文冲突拒绝。核对及估算不重新运行工具、解析当前工具实现或捕获新能力，不改变模型用量事实。Run级、step级及子Agent执行共用ExecutionEngine，新增工具无需登记。

私有证据沿原metadata及大Artifact封存路径保存，公开Inspector投影剔除toolResults，公开API和工具／协议版本均不改变。旧快照缺少证据时继续使用原定义及结果展示版本核验，不能凭现在的结果反向补造过去的证明。撤回RuntimeOptions.contextResultFormatters及Service的web_fetch专门登记。

## Alternatives considered

- 持续增加工具保留表：已实际实现过，但无法自动覆盖未来或step级工具，与本次明确目标冲突，因此撤回。
- 只保留内存格式器：不能跨退出冷读；保留完整工具或重新装配可能带入执行与网络能力。
- 冷读重新运行现在的格式器：现在的代码和展示版本不代表原请求；结果可能变动。
- 只复用封存正文，不绑定当前执行回执：无法拒绝结果／revision变化或错误来源。
- 为旧记录从当前状态补造证明：没有原快照证据，不能证明过去的结果身份；旧无证据仍沿原校验。

## Risks

新增工具不需要上下文专用接线。捕获和复核增加已消费结果的只读查询及摘要计算，metadata较大时使用原Artifact路径。稳定终态、精确身份、完整结果及原模型正文必须一致；未知或无原证据不承诺可估算。不新增公开调试入口、注册表、Store迁移或工具版本；TUI／Desktop／主子Loop共用Core能力。

## Acceptance criteria and historical checks

[通用Run／step冷读回归](../../../../packages/agent/test/isolated/context/result-presentation-estimate.test.ts)覆盖未登记的自定义工具、释放后冷读、当前格式器抛错仍不执行它、原结果变化拒绝、剔除证据模拟旧记录回退，以及零新增Model／Tool／能力读取。新私有证据不出现在公开Inspector。

[子Agent装配](../../../../apps/service/test/isolated/child-configuration.test.ts)整文件10项通过，核子Loop至少两步使用自己的实际工具与预算、私有结果证据及完成后的只读预测；[HTTP／压缩](../../../../apps/service/test/isolated/context-token-estimate.test.ts)4项通过，包括205次本地模型调用与冷只读；[metadata](../../../../packages/agent/test/isolated/model-snapshot/metadata.test.ts)4项定向通过，核私有／非法／重复证据及真实子元数据。该metadata文件另有17MiB SDK用例超时和Windows Artifact chmod EPERM；对照HEAD原runtime／execution／model-snapshot实现仍复现，保留为当前环境既有失败，不宣称整文件通过。

当前机制及限制归[Core owner](../../../../packages/agent/src/context-estimate.README.md)、[Service owner](../../../../apps/service/README.md)；前次弹层／读取恢复验证仍归[Desktop owner](../../../../apps/desktop/README.md#输入区上下文占用)。未重放用户原会话；旧记录缺证据不能视为修后实机已验证。
