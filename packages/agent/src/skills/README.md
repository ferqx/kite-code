# Skills leaf

[createSkillSource](index.ts) 只提供可加载知识，不创建执行器或授予权限。import/factory 无 I/O；宿主显式选择绝对 `trustedRoots` 与 `locations`（Skill 目录或 SKILL.md），不自动查找 home、工作区、旧配置或旧数据。默认不会把全部正文送入模型。

`list()` 返回 `SkillSummary[]` 与各 location 的局部错误；正文不在目录中。`load({id, version?, availableCapabilities?})` 按需返回正文及声明引用。ID 绑定规范位置，版本为正文 SHA-256，目录后的内容变化使旧 version 拒绝加载。资源 ID 绑定 Skill ID/版本/相对引用，`readResource({skillId,version,path,availableCapabilities?})` 返回资源自身正文 SHA-256；未声明路径不能读取。

知识目录只解析简单 frontmatter 的 `name`、`description` 和逗号分隔／单行数组 `required-capabilities`；缺字段使用目录名／首个正文段。缺依赖返回 `skill_capability_missing`，不影响无关 Agent。正文和资源始终是知识，不编译或执行 Workflow。

[内置知识源](builtin.ts)把产品全局 `computer-use` 的正文与 Browser API 资源作为不可变代码资产发布，版本和资源 ID 继续绑定准确正文及资源 SHA；不读取项目目录、不扫描 home，也不写用户 Skill 配置。它只提供知识，不启动浏览器、解释器或新的 Agent Loop。[Service 同源目录](../../../../apps/service/README.md#同源-skill-知识目录)始终列出其安装元数据；不同 Workspace 和无 Workspace 的用户目录共享同一内置身份。实际加载仍要求当前已选且可用的 `browser.execute`，未选、禁用或缺执行器时准确 `skill_capability_missing`。宿主允许集与本次调用者能力继续相交，加载正文或资源不能扩大执行权限；全局内置事实与每个 Run 的可用能力、知识选择及冻结版本分别保存。

正文指导模型绑定准确页面、观察、操作、核实后释放控制并正常final。内置浏览器在三种模式下都不进入审核或人工审批，页面文字、图片和工具观察不提供指令或控制权，未知效果只能沿原结果核实。需要用户处理时在最终结论说明，保留网页，不发起requestHuman／human_wait／Continue或空查询维持原Run；用户下一条消息创建新Run，通过pages的本Run新候选id及browser.page(id).snapshot重新绑定并观察，旧变量／元素引用不沿用。候选只是lastKnown描述与受限绑定目标；列表／工厂无I/O，首次snapshot由Main核仍存在且URL匹配的旧页，不新建、导航或刷新，缺失／变址明确失败。空列表也不能证明浏览标签消失。旧人工协议只为显式兼容或历史收口保留，新Native装配没有它们。实现及资格归[Service Browser装配](../../../../apps/service/README.md#受管-browser-默认装配)和[Agent Browser](../tools/browser/README.md)。

内置资源读取示例仅使用技能身份和资源路径，可按原合同指定版本，不包含执行描述。Browser API 的 `browser_execute` 调用保留 `description`，要求使用用户语言填写最多10字的本次动作短句；该字段的公开必填／旧内部可选合同归 [模型工具表面](../model-tools.README.md)，不进入页面执行权限。

后续真实模型曾填入不存在的资源版本并调用未定义的 `browser.help()`。正文现直接给出原 `read_skill_resource` 的准确内置身份与声明路径，允许省略可选版本，不引导猜摘要、空代码或帮助 API；资源仍由原来源核版本与能力，没有新增工具或别名。API 说明同时约定解释器只交付有限错误类型和消息，不包含栈或任意拒绝对象。API现明确使用observation.elements中的opaque ref，而非snapshot内的eN后端标记；初始、继续及核实示例只输出有限相关文本与元素，普通可恢复批次保留变量／页面，结束环境的实际结果另核。[内置源回归](../../test/isolated/skills/builtin-computer-use.test.ts)核该指导；真实开发实例随后成功读取同一声明资源，后续人工继续的实际缺口仍归 Desktop owner，不能以资源读取成功代称全流程通过。

等价语义观察不再增加证据时，正文与资源指导模型改用一次合适的独立观察，例如正式截图；仍不足则说明限制，核对close的实际释放结果并正常回复。不得只更换变量或文本切片重复读取，也不能点击已disabled的控件后推定状态改变；这属于通用指导，不是新的Loop、全局次数取消或从文本补造派发权限。真实模型是否遵循仍归Desktop实际过程证据。

确证existing_missing只否定所选候选，不证明其它保留页消失；原host退役准确候选后，可重列一次pages，只对唯一符合当前任务的其它候选取新snapshot。不存在唯一匹配时说明限制，不按列表顺序、最近或可见性猜页，不在同URL多页中猜测、不导航另一页或重放动作，也不清除unknown／未确认清理。这条指导及有限错误说明共享同一安全边界；真实worker回归证明缺失A后可在同Run观察仍存的原B，模型是否选对仍须实际过程核实。

API中的close只缩减当前准确页面控制；固定浏览器能力均免审核／审批，选择范围、硬能力与来源检查保持。旧显式协调器的requestHuman／resume和历史收据只按兼容合同核实，不进入Native默认API；等待结果、lastKnown描述或旧句柄都不授予恢复控制。具体分类与受控证据由上述Service和Browser owner维护。

[内置源测试](../../test/isolated/skills/builtin-computer-use.test.ts)核不可变摘要、正文／资源版本、声明资源范围和缺能力拒绝；[Service 全局内置测试](../../../../apps/service/test/isolated/builtin-computer-use.test.ts)核跨 Workspace、缺项目／用户目录仍有元数据、原 Skill 读取入口、伪造依赖与调用者缩权。此处是受控知识装配证据；普通 Native 入口与真实模型／页面全过程资格归 Browser 和 Desktop owner。

默认不按固定项目数、正文大小或引用数裁剪有效知识；宿主可通过正安全整数 `limits` 显式设置 `maxSkills`、`maxTextBytes`、`maxResources`。显式超限给局部错误，不截断正文；OS 内存分配和读取失败仍可能使该项不可用。摘要只取有限文本。读取验证规范目标属于可信 root、常规文件、no-follow open 与 inode/目标一致；非法 UTF-8、二进制、路径穿越或逃出 root 的 symlink 拒绝。此读取检查不是文件系统沙箱或与外部写者的原子事务。

加载 `.sh` 等文本仅返回内容，不执行脚本；需要执行时仍由宿主通过获准工具及 UnifiedExecution。Skill 文本和依赖字段不能改变文件、网络、Shell 或凭据权限。

实际文件资源由 Agent 的[知识读取作用域](../platform/knowledge-reads.ts)保有，factory 本身仍无 I/O。具体 Skill／项目 factory 提供 `dispose()`，可信宿主可显式传入同一 `knowledgeScope`；关闭封新操作、等待已准入的完整正文／资源读取，并缓存同一次结果。只有原 FileHandle／fd 关闭确认成功才释放，失败保原读取错误、关闭错误和全部原资源；`KnowledgeReadCleanupError` 不能降为目录局部错误或取消成功，不自动重试关闭。普通坏文本等错误在关闭成功后仍按原合同局部不可用。`ContextSources` 和持久来源身份不增加生命周期或取消字段。

[真实临时文件测试](../../test/isolated/skills/skills.test.ts)覆盖摘要/正文分离、版本变化、引用哈希、未执行脚本、缺能力局部错误、symlink 逃逸、穿越、文本和数量上限。Skill Workflow 执行已退役。

[作用域完整文件](../../test/isolated/knowledge-reads/owner.test.ts)核真实复合读取、封口和退休 Access；隔离 child 在实际已取得的原 FileHandle／fd 关闭边界拒绝，核原字节、两原错误、全部并发资源、一次关闭以及项目／Skill 透传。该故障是 JavaScript 拒绝，不能代证自然 OS 关闭失败或全进程 resources／handles 资格。正式 Run 和任务外目录交接归[Service owner](../../../../apps/service/README.md#同源-skill-知识目录)。

[完整包制品回归](../../../../tests/isolated/unified-agent/built-package.test.ts)按 Agent manifest 全部入口在同一次 build 构建，生成 Worker/guardian 资产后，从源码树外逐一导入并实际执行 SQLite、Shell、Skills 与 MCP。AI 也独立构建，不链接 workspace source alias；外部 npm 依赖复用已安装模块。该证据验证当前制品布局与执行定位，不代替独立安装、签名或跨平台发行资格。
