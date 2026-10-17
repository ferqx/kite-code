# Agent Note: 压缩维护与最终回复的准确边界

Status: implemented

## Problem

“了解当前项目”的实际会话在完整读取多份大 README 后两次发布摘要、第三次摘要时取消。摘要沿同一 Run 保存为完整 assistant 消息，Native 丢失实时压缩进度且没有持久压缩身份，用户看到类似最终回复后仍继续工具的过程。默认全文 Tool 读取放大输入增长；极小已知窗口下，摘要可能无法留下继续工作空间。

## Decision

用户确认总上下文窗口 75% 触发及默认 200 行分页。页基线仍验证完整文件，显式范围与低层完整 IO 保留。正常 Native 显示准确压缩状态，公共 Message 的压缩身份来自真实 Model 与 snapshot；Model succeeded 不等于摘要已发布，压缩摘要永不成为最终回复或复制内容。正常模型完整文本仍只是候选，实际 Run completed 才建立最终资格。

默认自动摘要须真实缩小；固定来源与工具或摘要后仍达到实际阈值时，以明确失败结束原 Run。后续验收发现用户配置的 `contextWindow: 1048576` 曾被归一化遗漏，错误走 32768 回退路径；现兼容该字段，并优先采用 `contextWindowTokens`。用户进一步确认：未声明窗口默认 256K（262144 token），75% 默认阈值为 196608；显式 `compression.thresholdTokens` 覆盖比例并随 Run 冻结，摘要后也按同一阈值验证。默认容量仍是配置声明，不构成 Provider 实际容量证明。摘要保原用户目标和真实未完成义务，不将未读资料扩写成待办。当前责任与验证见[Service](../../../../apps/service/README.md)、[Native](../../../../apps/desktop/README.md)及[文件 Tools](../../../../packages/agent/src/tools/files/README.md)。

## Alternatives considered

- 只调整阈值或默认页：不能解决完整摘要被当作最终回答，也不能保证极小窗口中维护有实际收益。
- 相同成功读取次数保护：本次主要读取不同文件，无法解释直接症状；增加通用配额还会截断合法长任务，因此没有采用。
- 用模型 succeeded 或热进度消失表示压缩完成：无法证明最终发布，保留 unpublished 与准确提交边界。
- 静默截断大正文：会混淆页内容、完整文件基线与真实读取；采用显式分页和完整 Artifact。

## Consequences

旧历史可只读分类，压缩不新增权限、SQL 表或执行调度器。Files read 和绝对 read 分别升 v4/v2，可信角色与调用方使用准确新版本，旧历史展示继续支持原版本。默认页不限制单行字节数；单个巨大行仍走完整 Artifact 并由上下文维护判定。具体测试范围随各 owner 的实际证据维护。
