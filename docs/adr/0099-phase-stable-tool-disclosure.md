# ADR-0099：V2 工具声明跨阶段稳定，Planning 权限由 Runtime Policy 裁决

状态：accepted
日期：2026-08-12
决策者：github:@ferqx
调整：ADR-0092、ADR-0098 中按 Planning/Building 裁剪 V2 工具面的部分；不改变 V2 默认启用或 legacy 回滚

## 背景

Prompt Contract V2 默认启用后，Planning 会从 Provider ToolSet 隐藏 `edit_file`、`write_file`、
`shell_execute`，把 `task.subagent_type` 收窄为 `explore | plan`，并隐藏 effective effects 超过 read 的动态
MCP。Building 再恢复这些名称与 schema。

该做法能降低模型提出 phase-invalid 调用的概率，但工具名称、description 或 JSON schema 是模型请求的一部分；
phase 切换会改变 Provider 前缀，不能继续假设 system/history 的长前缀可复用。它也完全移除了 Planning 的
`shell_execute`，使现有 Runtime Policy 已支持的 policy-proven read-only Shell inspection 无法被模型选择。
此外，Planning 已披露的只读 Registry/MCP capability 仍可能被旧的“剩余工具一律拒绝”分支误伤。

模型提示不是安全权威。Tool Controller 已能在 dispatch 前读取当前 phase、Registry effect、MCP binding policy
与 Shell command classifier，并为拒绝生成成对、结构化、未执行的 Tool Result。因此无需用 phase-dependent
ToolSet 代替 Runtime enforcement。

## 决策

1. V2 production builtin 的名称、description 与 Provider JSON schema 在 Planning/Building 保持相同：
   `edit_file`、`write_file`、`shell_execute` 始终披露，`task` 始终披露完整
   `explore | plan | code | review` schema。
2. 已发现且仍有效的动态 MCP binding 不因 phase 隐藏。Catalog/binding revision、execution capability surface、
   Skill lifecycle、feature flag 与 legacy recovery surface 仍可改变工具面。
3. V2 static prompt、ToolSpec contract 与动态 Runtime block 明确引导 Planning 不调用写入或副作用能力；
   `shell_execute` 只用于 Runtime 可证明只读的 inspection。测试、构建、安装、格式化、生成和 mutation 留到
   Building。
4. Runtime Policy 是最终权威：Planning 允许 policy-proven read-only Shell、MCP 和 Registry capability；
   edit/write、非只读 Shell、`task(code|review)`、side-effectful/unknown MCP 均不执行且不进入审批，向模型返回
   structured phase Tool Result 以便自主选择只读动作或写入 Plan。
5. legacy `promptContractV2=false` 保留原 explore/plan-only Planning task schema；本决策不删除 rollback。

## 验证

- 确定性工具测试逐项比较 V2 Planning/Building 的 builtin 名称、description 和 JSON schema 完全相同。
- Policy 测试证明 Planning 允许 `pwd` 等只读 Shell 和 read-only bound MCP，同时在 full access 下仍拒绝
  write/edit、非只读 Shell、code/review child 与 side-effectful MCP。
- production PTY 验证 outbound Planning request 含 edit/write/shell 和完整 task schema；随后真实 Runtime
  拒绝 `write_file`、不写文件、不请求审批，并把 phase error 送入下一模型请求；非只读 Shell 以
  `deferred=true/until_phase=building` 回灌。
- Prompt 变更后的真实 `full/full_access` 七类 × 十轮 Provider AB/BA 为 legacy 59/70、V2 65/70，
  V2-minus-legacy +8.57pp、95% 区间 `[-0.11pp,+17.26pp]`，5pp 不劣通过；两臂 safety violation、
  invalid tool、exact repeated call 均为 0，Provider evidence 140/140 闭合。当前候选的 V2 natural 与
  invalid-args production Runtime Journey 各 3/3 completed。A/B 的 cache-read aggregate 不是同会话 phase
  transition probe，不得声明 Provider cache hit 已改善。

## 影响

- phase 切换不再仅因 builtin/MCP effect 过滤改变 Provider ToolSet，保留缓存前缀复用的必要条件；实际命中仍由
  Provider、请求公共前缀、capability revision 和 session history 决定。
- 模型可能偶尔提出 phase-invalid 调用，但结果是未 dispatch 的明确 Tool error，不是审批或执行；模型负责根据
  Tool Result 自主调整，Runtime 不替模型生成参数或自动重放。
- 旧的 blanket Planning denial 被 effect-based policy 取代，使真正只读的 Registry/MCP 能力与提示词一致。

## 回滚

若稳定披露造成不可接受的模型循环，可新增决策恢复 phase-dependent disclosure；不得删除 Runtime phase policy，
也不得用提示词、schema 隐藏或 full access 代替执行前拒绝。
