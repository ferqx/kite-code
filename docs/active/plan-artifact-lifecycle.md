# Plan Artifact Lifecycle

状态：active
读取时机：修改 `write_plan`、Plan review、Task 生命周期、Runtime Context、TUI/CLI 审核展示或会话恢复时
验证：`bun test tests/runtime tests/tui-system/scenarios/plan-review.test.ts tests/tui-system/scenarios/plan-mode-policy.test.ts`

当前行为约束：

- 新 Plan 正文写入用户级 `~/.kite-code/plans/{taskId}/v{version}.md`；同一 Task 只拥有一条
  版本链，`planId` 继续保留在 Artifact metadata、Runtime event 和 digest identity 中，但不再作为
  文件系统层级；
- 当前在线路径只识别扁平 locator；旧版嵌套路径
  `~/.kite-code/plans/{taskId}/{planId}/v{version}.md` 不读取、不迁移、不复制也不主动删除；
- 新写入的 Plan 使用 `PlanDocument.planSchemaVersion=2`，而 Artifact 容器格式仍独立保持
  `artifactFormatVersion=1`；两者不得互相推导或同步递增；
- `save` 创建不可变版本并只返回 Artifact 元数据；
- 同一 identity 的重复 `save` 仅在规范序列化后的完整 Artifact 内容完全相同时幂等；即使 structural
  digest 相同，只要 status、completion evidence 或 replan metadata 不同也必须返回 `artifact_conflict`。
  新版本先写入同目录的独占临时文件，再通过原子 no-clobber 发布；`EEXIST` 竞态必须读取现有普通文件并
  进行同样的全文比较。Artifact read/write 共用 no-follow 路径边界：managed root 下每层 task
  ancestor 必须是可核对身份的真实目录，最终文件必须以 no-follow 打开并经 `fstat` 确认为同一普通文件；
  发布前后复核 parent identity。临时文件只在 parent identity 未变化且 inode 精确匹配时按已知路径清理，
  不跟随、遍历链接或沿被替换的 parent 删除外部内容；
- strict identity 下跨 turn 重复 `save`，仅当当前 document 已是当前 revision 保存后的 canonical draft 且
  structural digest 未变化时，才精确复用该 V2 document 与 Artifact，包括原
  `createdAtTurnId`/`updatedAtTurnId`、step status、evidence 和 replan metadata；不得用当前 turn 重写同一
  identity 的任一字段。executing direct replan，或刚进入 `replanning_draft` 但仍持有旧执行版本时，即使
  结构未变也必须创建 v+1 Artifact，记录 superseded version/reason，并把步骤与 evidence 重置；该新 revision
  保存后，下一 turn 才可按新 identity 幂等复用。对应 `plan.drafted` replay 只有在完整 AgentPlan transport、
  Artifact ref 与 revision metadata 都和旧 canonical document 一致时才可幂等复用，否则 fail-closed；
- 首次 `save` 由 Runtime 根据 Task identity 确定生成稳定 plan identity；因此 Artifact 已原子发布但
  `plan.drafted` 尚未提交时，重试仍命中同一不可变 v1，而不会因随机 identity 永久冲突。no-clobber
  发布必须同步 Artifact 文件和本次创建的目录项后才允许 Runtime 提交事件；后续 `save`、`submit`、executing replan 和
  `update_plan` 都必须携带并精确匹配 `{ plan_id, version, structural_digest }`；缺失与过期
  identity 分别稳定拒绝为 `plan_identity_required` 和 `plan_identity_mismatch`；
- 审核事件引用 Artifact，UI/CLI 从 Artifact 读取正文；
- Artifact write/read、Plan facade 写入与 reducer V2 replay 共用同一个完整 `PlanDocument V2`
  validator：标题/正文长度、step 数量、唯一且合法的 ID、单行 title、status 枚举、completion evidence、
  Artifact identity 和 structural digest 都必须有效；step 只能包含 ID/title/status 与可选 note，Markdown
  标题必须与 metadata title 一致。不能依赖 TypeScript 静态类型接受未知 JSON，也不能在 step 中夹带
  command/path/stdout 等额外字段。parser 在挑选字段前先检查 raw metadata allowlist：V2 顶层
  `stdout/prompt/path/extra` 一律拒绝；V1 只兼容 artifact/task/plan/version/title/digest/steps/turn identity 与
  历史 replan 元数据，不以“忽略未知键”扩展兼容面；V1 可选 `supersedesPlanVersion` 仍必须是正整数，
  `replanReason` 仍必须是至多 500 字符的字符串，不能让未知 JSON 伪装成类型正确的历史正文；
- 同一 Task 内版本递增，新顶层目标创建新的 Task 和 Plan ID；
- 审核取消保留草稿，Artifact 缺失或 digest 不匹配不得提前清除审核 interaction；
- V2 Artifact metadata 可保存 `PlanCompletionEvidenceV1`，但只允许 verification ID/outcome、
  terminal tool-call ID/outcome、skipped step ID/reason code 和 unresolved kind/reference ID；不得保存
  prompt/tool body、路径、命令、stdout 或任意错误正文；
- 当前 Runtime 只创建和接受 PlanDocument V2；Runtime snapshot 还必须具有精确 schema version 与 format
  epoch。旧 RuntimeStore 不迁移、不 replay、不改写，也不存在 recovery-only Plan 工具面；打开不兼容
  会话时在 decode/dispatch 前返回明确错误。既有 Artifact 文件不主动删除或搬移。

详细实施方案见 [`2026-07-13-plan-artifact-lifecycle.md`](../space/plans/2026-07-13-plan-artifact-lifecycle.md)。
> 测试路径同步：当前 runtime state/store conformance 测试使用无版本文件名；持久格式版本仍仅保留在 metadata。
