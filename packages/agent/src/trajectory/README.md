# Trajectory 只读事实与材料

2026-11-09输出存在性补充：真实writer／display及相关材料回归5文件40项564断言通过，核工具独占、小正文附工具、大正文、大工具参数、Artifact描述符与preview区别、流式前缀及成功／失败／取消／重试；原材料和引用保持。Agent1192文件类型检查与4文件Biome通过，未调用真实外部Provider。纯规范、传输和生产组件的证据分别归其owner。

2026-11-10节点内容补齐：[公开交互投影](evidence-projection.ts)从原已封存request.schema的唯一object表单分支提取问题标识、题干与const选项；显式questions按同一有限白名单保留。审批options只保原label／description或原presentation.label／details以及准确optionId，不公开scope／grant／permission／proof。原answer.answers可以为对象、数组或标量，不因不是数组而丢弃；null不是取消证明。公开字段沿既有interaction准入，无新类别、协议或工具版本，不能用当前工具schema补旧问题。原schema歧义或缺字段保持缺失，准确答案原值继续保留。

同日完整 Native 对话复核补充：writer 仅由准确原 `Command.kind=authorization.check` 且无 Run 的 Model 封存既有 `display.operation=review`，不要求该 Command 另有规范事件，也不按模型名猜审批。公开压缩 Context 只从原 compression／compression_pending 投影覆盖上界与摘要发布消息序号，发布 0 保留为未发布；不将其混为全局事件游标。待答审批仅对准确原 `shell.execute@1` 提取 command／workdir 及有限文件、网络请求范围，不公开 env、grant、策略或凭据；未知工具和版本不猜动作。Context／Interaction 的 partial 表示有限公开预览，不代表生成仍在进行。真实 SQLite 审批分类 3 项97断言、Context／Interaction 投影 10项56断言通过；完整 Native 过程与客户端范围见[Desktop owner](../../../../apps/desktop/README.md#执行轨迹离线窗口与-trace-设置)。

[原事务 writer](../storage/sqlite/trajectory-facts.ts)在原 `change_event.trajectory_fact_json` 封存规范事件及私有材料检查点；[Reader](../storage/sqlite/trajectory-reader.ts)只解释这些封存值，不从当前业务行补旧状态。当前 Store 是读取准入，事件的 `origin` 是原提交出处；恢复后两者可不同，eventId 保持原摘要。旧格式以当前 Store 的兼容命名空间生成 `legacy_local` 身份，不跨恢复副本去重。

Run、Execution、Operation、父 Execution 和 Model retry 的前一 Execution 另封存各自可核实的原实体 Store。事件在恢复后的新 Store 提交，不代表被观察的原实体也属于新 Store；缺失出处证明时不从当前 Store 或事件 origin 补造跨副本关联。child 关系由原 carrier Job 的 childSessionId 与子 Session 自己的事实表达，父 Session 的分页不会混入 child 正文或 Execution，准确子范围须另行读取。

当前 writer 的字段来自以下原 owner，不将任意 extension record 或自由 JSON 解释成业务事实：

| 原事实 | 规范事件和材料 |
| --- | --- |
| Message | 原 messageId、role、seq、状态与当前观察修订；同一回复的增量和完成分别封存，完整消息正文及原部件版本存私有binding，第一方另有下述有界公开摘录，用户输入归原Run，回复仅关联已确证Model |
| Command／Operation／Input | 原 Command 身份、类型及符合有限 code 语法的回执 reason／outcome；自由异常正文不作为展示字段 |
| Run | 原 Command／root work、取消标志及受限 reasonCode；活动取消请求为 cancelling，真实终态到达后才结束 |
| Model | 原 Execution／attempt／retry 来源和 usage；确证压缩调用另封存 compressionId／compressionTrigger，准确 input／metadata／dispatch 授权及输出 head／前缀只存在于私有 bindings |
| Tool／Job | 原 resultRevision、Tool callId、Job child／delivery 原因及输出检查点；只封存真实结果，不以效果未知代替成功 |
| Interaction | 原 interactionKind、requested／answered／accepted／cancelled 决定和准确 revision，pending 显示 waiting_interaction；接受决定不补造新回答版本 |
| Context | 原 selection、发布 cursor revision，以及 selected／compressed／published action；压缩结果另封存原 compressionTrigger 与确证 Model 关联，私有 assembled request 不进入公共事件 |
| Recovery | 原 session.recovered／session.reconciled 记录为 observed 的 interrupted／unknown；原 Execution 的 outcome_unknown 事实继续保留 |
| Artifact／Files | 原 Artifact 引用；成功 Files write/edit 的已核对原回执可另封存 file_change，普通任意 Tool JSON 不能获得该材料类型 |
| Verification | 仅原 mutation-check owner 的准确检查 revision／outcome 和私有检查点；不泛化解释 extension record |

未识别的真实来源类型仍明确是 unknown，不能据已知 envelope 宣称完整业务矩阵。Command／Run 的 reasonCode 只是语法受限原因，事实本身不构成执行、恢复或额外材料读取权。

[消息封存](../storage/sqlite/trajectory-message.ts)只在原消息变更或已核实的输入决定事务中取当时版本：用户身份按原Command／Run／主体及输入原文核实，工具结果和Agent邮件不因role=user获得用户消息身份。内部压缩和标题消息仍归原模型记录；输入解释的原JSON不会作普通回复，先保存当时公开等待说明，再由原`human.input_decided`事实封存核实后的answer／clarification。消息Evidence只输出正文与公开附件描述，不透传source、reasoning、权限或URI；大回复复用原封存Model输出head和前链，读取不查询当前消息或最新回执。Fork直接复制且没有原消息事实时不补发历史消息；原关联或分类无法证明时仍保持原事实。

`openTrajectory` 返回固定全 Store upper 和纯值 descriptor，不登记服务端 reader。一次 SQL 汇总依据格式启用边界、原事实格式和现有历史收集标记计算 coverage，应用所选 Run／Execution／kind 过滤；它不提前投影整个历史，也不宣称已验证全部事件语义，未逐页验证的事实完整性保持 unknown。未知、缺失和坏格式分别记录原因。旧 baseline 的只读打开没有新增列，Reader 仍可解释原日志封存字段，coverage 标为 legacy。

`readTrajectoryEvents` 每次在短只读事务重新核当前 Store、原 root creator 主体、实际 Session、可选 Run／Execution、固定 upper 及真实历史收集标记。最多扫描 200 个全局来源位置，输出最多 200 项和 512 KiB；跨 Session／kind 的过滤空页仍推进 `scannedThrough`，没有 `cursor+1` 连续性假设。后续追加和通知 floor 不改变旧窗口；真实源回收明确拒绝。Abort 只取消当前上层调用，无跨请求 page lease 或 close 协议。

新事实经公共闭合 schema、原 cursor／类型／scope 及 origin 摘要复核。坏或未知格式只提供安全 unknown envelope 与完整性原因，不传原 payload、自由字段或私有材料。材料 partial／truncated 不自动降级已经存在的事实完整性，分页穷尽也不等于历史、操作或正文完整。

`readTrajectoryBinding` 是 Runtime typed Evidence owner 的私有接缝。它重新准入准确 eventId、atCursor≤upper、evidenceId 与 contentVersion，验证原 ref／kind、规范内容 SHA 和 opaque evidenceId，只返回当时版本；未可见、跨 scope、错版本或损坏检查点明确 unavailable。这个接缝不授予通用 Artifact／私有 Model 正文的下载权，Service 和扩展不能直接取得其值。正式正文分块的 lease、权限 epoch 和取消归上层 Evidence owner。

[Runtime.readTrajectoryEvidence](../runtime.ts)复用 `readSealedModelInput`／`readSealedModelOutput` 及既有公开 Model 投影，使用封存的原 subject／Execution／出处、准确输入 body 或输出 head 展开原版本；不调用当前 `getModel*Snapshot`，也不放宽为 advanced/latest。opaque continuation、内部工具映射和授权绑定不进入公开正文，原 source digest 只在内部验证，返回的是规范 UTF-8 公开视图及明确 transformation。读取前后重新核原 binding，取消不返回成功前缀。

Tool 的 `tool_input` 在原 Execution 事件事务封存实际 `intent_json`，正文按原主体、Session、Execution、原实体 Store 和定义／版本读取，返回完整 JSON 值；null、空对象、数组及标量均保留，不用缺省对象替代。完整参数保存在私有 binding，公共索引保留材料 ref，不复制整份参数对象；Job 程序和 Model 请求不经过这个入口。没有原 ref 的旧事实不从当前 Execution 补参数。[参数／历史回归](../../test/isolated/storage/trajectory-flow.test.ts)核大参数、取消后旧版本、后来输入变化、错版本与异主体拒绝。

第一方列表另由[纯展示提取](display.ts)及[原事务关联核验](../storage/sqlite/trajectory-display.ts)封存可选闭合 `attributes.display`；这不是 `tool_input` 正文复制，也不改变原事件、Execution、父子关系或材料权限。Tool 必须匹配原决策 Model 的冻结 binding，或原 Run 注册的准确 extension／definition／version，未知定义和版本不获得猜测摘要。当前有限目标包括 Files 原请求路径、移除 userinfo／query／fragment 的 HTTP(S) 目标、Task 显式展示名及安全操作分类。准确 `builtin.shell` v1 的 execute／launch 仅将原 `description` 展示字段压为单行并限制 320 字；缺描述不把 command／commandPreview 或 stdout／stderr 搬到索引，也不替用户推测命令用途。真实完整参数和结果继续走 Evidence。

已核实的用户／Agent 消息另可封存 `display.kind:message`、角色标题和不超过 160 字符的公开摘要，只取该观察版本的内联 `body.content`，压为单行，超长以省略号标记。不读 reasoning、图片编码、私有 source、checkpoint 输出头或 Artifact 正文来补摘要；没有内联 content 的观察保持缺失。完整原文仍由准确 message Evidence 读取；新观察缺少 display 不继承旧版摘录。第一方索引和未含材料的本地轨迹导出可以含这些有界公开文字，不能称为完全无正文；它不开放完整材料，也不扩大第三方 Trace 的 metadata 或 Evidence grant。旧事实不回填公开摘录。

Model 展示名只取原冻结 adapter 的可用 `provider.modelId`，不以配置别名或 Execution ID 冒充实际模型。`requestContext` 只计当时请求的 system 消息、非 system 对话消息（含当前输入和工具结果）与公开工具目录项；工具数优先使用冻结的公开 `toolSurface`。实际请求或 metadata 需封存为 Artifact 时，[执行准备](../execution/index.ts)与 Runtime 在正文转引用前计算这一闭合摘要，metadata 的原 `version:1/body` 外壳可另保留可选 `display`，只允许 Model 名称与上述计数，不接受正文、目标句柄或自由字段。小 metadata 遇到大请求也沿同一外壳保留准确计数，SQLite writer 不预读 Artifact。typed reader 闭合校验可选摘要后仍展开和验证原 metadata 正文，公开 Inspector／Evidence 不返回外壳；原无 `display` 外壳继续可读。计数不复制提示词、source 正文、schema、权限或凭据；旧引用没有摘要时保持缺失，也不补 0。旧事实和 opaque adapter 的缺项不以今天的状态追补，按需打开的准确 Model 输入材料仍可展示其原冻结模型信息与请求内容。

Shell 的 read／wait／stop 与原执行归属，只在回执内容一致、准确 Job／Store／Session／Command 和父启动 Tool 的原定义一致时记录 `targetExecutionId` 及原出处；启动工具与查询工具仍是独立原记录。`observedStatus`、等待超时、停止请求和退出码来自该次真实观察，受理不证明启动，读取成功不证明命令成功，停止受理不证明进程已停止。Job 自身仅在原 operation owner 与定义匹配时取得 Shell／Task 分类。直接 child 的 `work_ref` 只作无损解码，须再核真实 carrier、原 Command owner、Store 和 `child.parent_id`；准确 child Run 还核原 reference、启动 Command 和 root work。Task message 只有稳定 child Session 时不选“最新 carrier”，多目标 events／list 不取任意首项；accepted 也不改写为完成。正常列表无需预读这些工作项的材料正文，状态未知与独立的新调用继续保留。

同一原事务另可由[输出存在性提取](../storage/sqlite/trajectory-output-presence.ts)封存 `display.outputPresence`，绑定刚登记的准确 `model_output`；assistant Message 只有原 Model／checkpoint 已核实才绑定其自己的 `message` 引用。内联输出须具有明确正文和有效完整工具数组；Artifact 输出使用原登记描述符的 `contentBytes/toolCallCount/complete`，不能使用可能为空的预览工具数组或正文预览。该摘要不读取 Artifact 正文、不复制思考或私有引用，也不从当前业务行回填旧事实。失败、取消、未知和无准确字段均不构成“完整工具调用输出”的证明；公开材料仍逐字保留。[真实 writer 回归](../../test/isolated/storage/trajectory-display-flow.test.ts)覆盖内联、大正文、大工具参数、流式前缀、成功／失败／取消及重试的原引用和 as-of 完整性。

`display` 是第一方本地产品索引，第三方 Trace schema 明确 omit，Service 独立白名单不复制；既有 metadata／Evidence grant 不会扩大。字段定义与纯 as-of 投影归[Trajectory owner](../../../trajectory/README.md)。版本保持原值，缺 display 的旧 V1 事实继续合法。

`tool_result` 新检查点使用私有原 identity／result wrapper；[白名单展示 owner](tool-result-presentation.ts)只接原 Run 注册或原决策 Model 的准确定义／版本／extension binding，输出闭合 `presentation`。Files、Shell、Web、Browser、Task、Planning、Worktree、Skill、Question 与已验证 MCP 结果只提取各自公开字段；任意 details、权限、transport、凭据及调用引用不作为展示数据。MCP 的原 `structuredContent` 是明确的远程公开结果数据，不授予执行权。未知定义／版本和旧检查点保原 outcome／公开 content fallback，不由 renderer 从任意 JSON 猜正文；完整 `modelContent` 仍读取封存的原 Artifact。Tools 正式 `artifactRefs/modelImages` 只有在原事务复核同 Execution owner、主体、原 Store、size／mediaType 后才绑定 Artifact Evidence，重复引用合并，伪引用和私有 Model 封装不开放；不会取今天的文件或浏览器截图。原 Blob ref 继续参与现有 GC／备份闭包。

[受控展示反例](../../test/isolated/model-output/tool-result-presentation.test.ts)核定义／版本不匹配、回执差异和私有字段注入；[真实 Store／Artifact／Runtime 材料回归](../../test/isolated/model-output/trajectory-tool-evidence.test.ts)核完整原正文、PNG／PDF、伪引用／私有封装与异主体拒绝，读取不执行 Model／Tool、不改变水位。压缩 Model 和发布 Context 的摘要 Evidence 只返回原 `content/complete`，不返回 reasoning；生成成功与实际采用分开，统计口径归[压缩 owner](../storage/sqlite/context/compression.README.md)。事件、工具和协议版本保持原值。

Job／Tool progress 读取普通输出原行至封存 `upperOutputSeq`，gap／droppedBytes 只取封存检查点，不采用后来 coalesced gap 的累计值；正文明确标记 `retained_preview`，不宣称完整 stdout／stderr。Tool result 只提供原 outcome／content，原 `modelContent` 由准确 Execution 和 Artifact owner 展开。通用 Artifact 经原 `readArtifact` 私有 Model 拒绝路径并核完整原 ref／hash／size。Interaction 仅投影保存的展示字段与闭合回答，Context 仅投影保存的 selection 边界；两者当前明确是 partial preview，不透传 source、权限、私有 assembled request 或自由授权对象。

私有 `model-body-`／`model-output-` 封装及 Model output MIME 的 Artifact 发布观察标为 `redacted`，不登记通用 Artifact Evidence binding；真实 Model 输入／输出仍只由对应 typed Evidence 读取。旧格式事实若曾将这些封装标为可用，原通用下载门禁仍拒绝，不据此开放正文。

Files 的 `file_change` 读取已封存的 UTF-8 有界 text、原 before／after baseline 和 truncated 标记，复核原成功 write/edit 回执与 postimage 一致；不会读取今天的磁盘或重新计算 diff。Verification 当前也只是原检查身份／修订／结果的 partial preview，不输出自由证据或授权对象。[原 Files 回归](../../test/isolated/files/change-preview.test.ts)另经真实 Runtime Evidence 验原回执预览，失败和未知发布不能伪造成功材料。

[真实流式 Evidence 回归](../../test/isolated/model-output/trajectory-evidence.test.ts)核完成后旧 prefix、公共 Model 视图复用、取消和零新调用／水位；原 [17 MiB 输入](../../test/isolated/model-input/inspector.test.ts)及[17 MiB 输出](../../test/isolated/model-output/output.test.ts)另经新 Evidence 路径展开完整材料并核损坏拒绝。[Job 回归](../../test/isolated/storage/jobs.test.ts)核超 1 MiB 后 gap 继续合并时旧 Evidence 字节和计数保持，读取零 Model／权限调用与业务写入。这些是 macOS／Bun 1.4.4 的受控本机材料证据，不替代 Native 分块体验或其他平台资格。

[定向真实 SQLite 回归](../../test/isolated/storage/trajectory-reader.test.ts)覆盖超过 200 项、全局空洞、空页、固定 upper 与后来状态变化、主体／Store／scope 拒绝、通知 floor 独立、现有 GC 标记、超过安全整数、坏／未来事实不影响原 Session Logs、准确旧 Evidence 与篡改拒绝、旧 schema 无写降级。测试使用本机受控 Store，没有 Provider／Tool 调用，不证明 Native 体验或第三方运行资格。迁移、备份与恢复范围归[Store](../storage/README.md#trajectory-事实格式与一次性边界)及[维护](../maintenance/README.md#trajectory-原事实的维护)。

[原事务与故障流回归](../../test/isolated/storage/trajectory-flow.test.ts)通过真实 API 验证 INSERT 后故障导致 business／event／binding／cursor 一并回滚；独立原 writer 在 business commit 后、Reader 或投递尚未运行时 SIGKILL，readonly 重开仍取得原 eventId 和输入检查点。另核 cancelling 到真正 cancelled、Interaction 1／2／2 修订及准确三份材料、恢复 unknown 不被后续事实覆盖，以及 child 原 Session 与父范围拒绝。它不手工构造规范事件，不使用生产调试 flag。

2026-11-09，`e8a483d65` 加本轮工作树，macOS arm64／Bun 1.4.4：[真实 display writer 回归](../../test/isolated/storage/trajectory-display-flow.test.ts)与[展示隐私反例](../../test/isolated/model-output/trajectory-display.test.ts)最初合跑 7 项、66 断言通过，核真实长用户提示词／回复只封存有界公开摘录，而 message Evidence 仍逐字保留全文，reasoning／附件编码／checkpoint 不成为摘要来源。另核 Shell 只启动一次、启动／读取／等待均关联同一原 Job、等待超时仍运行、后来结果保退出码 0，以及直接子 Agent 的受理／观察和消息归属；原 Shell 描述有界显示，不复制命令、私有模型输入、环境凭据或任意结果。当前六个 Task 的 typed 结果核原公开回执一致，不复制内部 detail 树。上述两文件与原 Store 的 flow／reader／schema 三文件合跑 37 项、366 断言通过，保留原消息修订、授权与材料边界。随后增加原请求／metadata Artifact 外壳回归，展示两文件与[原 Inspector](../../test/isolated/model-input/inspector.test.ts)合跑 13 项／176 断言通过：真实大请求分别配小 metadata 和超过 64 KiB 的工具目录 metadata，原实际模型名和计数均保留，完整 Evidence 与实际发送请求一致，读取不推进水位、不新调 Model；移除可选摘要的旧外壳仍可读，自由字段注入拒绝。Agent 1191 文件类型检查通过；[原日志](../../test/isolated/storage/session-logs.test.ts)、[内部准备](../../test/isolated/execution/internal-model-preparation.test.ts)与[完整检查输出](../../test/isolated/execution/authorization-check-complete-output.test.ts)合跑 30 项／583 断言通过。定向展示命令为 `bun test packages/agent/test/isolated/storage/trajectory-display-flow.test.ts packages/agent/test/isolated/model-output/trajectory-display.test.ts`。这些是本机受控 Model／Job 与真实 Runtime／SQLite 事务，不代表真实 Provider、安装版 Native、外发或跨平台资格。

2026-11-08，`e8a483d65` 加本次工作树、macOS／Bun 1.4.4：Reader 与 flow 矩阵 11 项／110 断言通过；与 schema／preflight／构建合跑共 27 项／212 断言通过。Model input Inspector、完整 Model output、流式 Evidence 与 Jobs 合跑 25 项／277 断言通过，包含真实 17 MiB 输入／输出和旧 gap 检查点；Files 整文件 6 项／98 断言通过。backup 9 项／86、restore 11 项／190、GC 6 项／108，以及 DB10 profile 1 项／32 断言通过；Windows 维护 4 项仅按平台跳过，不记 Windows 资格。backup／GC／DB10 使用独立进程选择的真实动态 SQLite 3.51.3，没有与默认引擎测试混用初始化状态。这些记录证明对应断言，不外推 Native 过程体验、真实远程 Provider 或完整发行资格。

同一工作树另执行 Agent owner 的429个原计划作业，复用已完成作业并补齐未执行部分；本次闭包与 reader 提取所需的测试夹具修正后，412作业通过，17个既有作业仍失败。未修改的 HEAD 源码独立副本使用相同外部依赖、原 workspace 映射和相同原生 Files 资产，对照也在这17个作业失败：包括旧 Task cursor／Files 参数或展示夹具、规划／Ask 参数、Model retry 预期、Windows专属准备、旧私库格式及 PTY 英文按钮预期。没有将这些用例计为通过，后半段未触达的断言仍未取得资格。原始 host／remaining／HEAD 对照日志保留于本机 `.cache/trajectory-agent-tests-*.log`；原模型／工具／业务语义未为其失败放宽。默认执行环境另直接拒绝既有 worker 的嵌套 macOS sandbox，宿主权限下原 browser execute 和 human-async 整文件分别83／67项通过；人工接管默认环境的瞬时状态漏采仍只记为时序敏感观察，不与该权限限制混为一谈。

同环境另以真实 Runtime 创建大于 inline 阈值的 Model 输入／输出，保存原 event/ref 后关闭并通过公开 backup／restore 更换 Store，再由新 readonly Runtime 调用原 `readTrajectoryEvidence`：117702 字节输入视图与 126070 字节输出视图逐字节相同，原事件出处保持，当前 Store 使用新身份，读取前后 metadata 不变；Model 总调用仅原来的一次，冷读 Model／permission 端口均配置为调用即失败。此检查直接覆盖新 Evidence 接口的恢复接缝；17 MiB 容量和损坏边界仍由上述整文件回归承担。
