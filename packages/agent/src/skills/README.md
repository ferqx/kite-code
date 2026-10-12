# Skills leaf

[createSkillSource](index.ts) 只提供可加载知识，不创建执行器或授予权限。import/factory 无 I/O；宿主显式选择绝对 `trustedRoots` 与 `locations`（Skill 目录或 SKILL.md），不自动查找 home、工作区、旧配置或旧数据。默认不会把全部正文送入模型。

`list()` 返回 `SkillSummary[]` 与各 location 的局部错误；正文不在目录中。`load({id, version?, availableCapabilities?})` 按需返回正文及声明引用。ID 绑定规范位置，版本为正文 SHA-256，目录后的内容变化使旧 version 拒绝加载。资源 ID 绑定 Skill ID/版本/相对引用，`readResource({skillId,version,path,availableCapabilities?})` 返回资源自身正文 SHA-256；未声明路径不能读取。

知识目录只解析简单 frontmatter 的 `name`、`description` 和逗号分隔/单行数组 `required-capabilities`；缺字段使用目录名/首个正文段。依赖能力缺失返回 `skill_capability_missing`，不自称已安装，更不会阻止无关 Agent。完整 YAML 与原 Workflow Contract 由独立[编译器](workflow-contract.ts)负责，生命周期通过[显式业务扩展](../business/skill-workflow/README.md)接入；知识加载不会隐式激活 Workflow。

默认不按固定项目数、正文大小或引用数裁剪有效知识；宿主可通过正安全整数 `limits` 显式设置 `maxSkills`、`maxTextBytes`、`maxResources`。显式超限给局部错误，不截断正文；OS 内存分配和读取失败仍可能使该项不可用。摘要只取有限文本。读取验证规范目标属于可信 root、常规文件、no-follow open 与 inode/目标一致；非法 UTF-8、二进制、路径穿越或逃出 root 的 symlink 拒绝。此读取检查不是文件系统沙箱或与外部写者的原子事务。

加载 `.sh` 等文本仅返回内容，不执行脚本；需要执行时仍由宿主通过获准工具及 UnifiedExecution。Skill 文本和依赖字段不能改变文件、网络、Shell 或凭据权限。

实际文件资源由 Agent 的[知识读取作用域](../platform/knowledge-reads.ts)保有，factory 本身仍无 I/O。具体 Skill／项目 factory 提供 `dispose()`，可信宿主可显式传入同一 `knowledgeScope`；关闭封新操作、等待已准入的完整正文／资源读取，并缓存同一次结果。只有原 FileHandle／fd 关闭确认成功才释放，失败保原读取错误、关闭错误和全部原资源；`KnowledgeReadCleanupError` 不能降为目录局部错误或取消成功，不自动重试关闭。普通坏文本等错误在关闭成功后仍按原合同局部不可用。`ContextSources` 和持久来源身份不增加生命周期或取消字段。

[真实临时文件测试](../../test/isolated/skills/skills.test.ts)覆盖摘要/正文分离、版本变化、引用哈希、未执行脚本、缺能力局部错误、symlink 逃逸、穿越、文本和数量上限。此切片未替换正式入口或旧 Skill Workflow。

[作用域完整文件](../../test/isolated/knowledge-reads/owner.test.ts)核真实复合读取、封口和退休 Access；隔离 child 在实际已取得的原 FileHandle／fd 关闭边界拒绝，核原字节、两原错误、全部并发资源、一次关闭以及项目／Skill／Workflow 透传。该故障是 JavaScript 拒绝，不能代证自然 OS 关闭失败或全进程 resources／handles 资格。正式 Run 和任务外目录交接归[Service owner](../../../../apps/service/README.md#同源-skill-知识目录)。

[完整包制品回归](../../../../tests/isolated/unified-agent/built-package.test.ts)按 Agent manifest 全部入口在同一次 build 构建，生成 Worker/guardian 资产后，从源码树外逐一导入并实际执行 SQLite、Shell、Skills 与 MCP。AI 也独立构建，不链接 workspace source alias；外部 npm 依赖复用已安装模块。该证据验证当前制品布局与执行定位，不代替独立安装、签名或跨平台发行资格。
