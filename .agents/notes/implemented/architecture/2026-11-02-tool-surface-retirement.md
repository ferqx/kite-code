# Agent Note: 退役 Skill Workflow 与专用外部文件工具

Status: implemented

2026-11-05 部分替代：[Full 外部修改决定](2026-11-05-full-mode-external-file-mutations.md)允许最终有效 Full 权限下的 `write_file/edit_file` 直接处理外部绝对路径，并为安全可编辑目标提供完整读取基线。下文“外部修改使用 Shell”和“外部读取不生成基线”仅保留为此前范围及当前非 Full／普通只读路径的说明；Workflow、专用外部工具、检索与验证工具的退役决定和历史恢复边界继续有效，不恢复旧工具或 alias。

同日后续：用户在完成替代评估后确认继续移除三个模型检索工具和五个验证工具，并一起退役专用验证机制。`request_plan_review` 保留，普通目录／文件／正文检索改走 Shell，客户端封装固定 rg。当前默认数量为有 Shell 时16项、无 Shell 时11项；下文“先保留检索”和19／14项记录前一阶段的取舍，已被本次后续确认替代。MCP 用途结论仍适用。Windows 无账户受限 Git Bash 与 Full 均已接原 V6 runner，边界与本机验证归 [Windows active](../../../../docs/active/windows-shell-sandbox.md)。

Windows 后续核对：用户明确选择无账户 unelevated 边界，取消此前额外要求的读取隔离与系统断网前置；业务允许／拒绝仅归统一权限层，runner 落实最终批准范围，不按默认 Workspace 再拒绝获批的外部写入。账户候选已撤回，测试账户／规则与旧缓存已清理。原批准文件分支能运行 Git Bash，但不能静默用于未批准的 Workspace 范围。当前独立 IPC 适配层只补 MSYS 对象的 Logon SID 兼容，不改变令牌或目录 ACL；Full／完整文件范围保另一份未修改 MSYS 映像，避免混合并发共享区冲突。四组文件／网络范围继续分别传递，联网不扩大文件范围。只读 Task 改用逐次参数限制的字面 Shell 检索，未知命令仍由原权限／角色上限决定。

## Problem

工具盘点发现 Workflow 的六个生命周期工具与显式激活入口构成独立执行能力；专用外部读写三个工具则与文件读取及 Shell 重复。用户明确要求完整删除 Workflow 执行实现和客户端入口、删除专用外部文件工具，随后确认外部路径改用 Shell 或统一 `read_file`。普通 Skill 知识和三个 Workspace 检索工具保留；MCP 仅评估用途，本次不移除。

## Decision

- 删除 Workflow 契约编译器、计算 Worker、执行扩展、verifier／compensator、宿主装配与六个工具定义；删除 CLI `--activate-skill`、TUI 动态 Skill 激活、manual 目录及公共导出。普通 `--skill`、`/skills`、知识加载和 Planning 保留。
- 删除 `read_user_file/write_user_file/edit_user_file` 的定义与装配，不保留 alias。统一 `read_file` 在原定义下读取准确工作区外文件；当时确认的外部修改路径为原受限 Shell，后续 Full 直接修改范围由上方替代决定说明。
- 用户对照成熟 Agent 后确认外部只读简化：普通文件读取复用统一权限与路径保护，不生成完整基线、不要求 owner／单链接、不重复核父子授权证明。请求与实际路径仍受私有数据／Runtime 资产规则约束，保留分页、取消和完整结果；不加载外部项目指令、不进入 Workspace checkpoint。
- 保存的 input/plan/output 私有引用适配器保持原准确授权，位于普通外部读取层之上。旧工具配置和 Workflow 激活明确拒绝，历史查询不重放；维护格式仍保留旧 Workflow 配置原字节及格式识别字段。
- 不递增工具定义、协议或维护格式版本；没有新增生产调试入口或放宽取消、未知效果和恢复要求。

## Alternatives considered

- 仅隐藏 Workflow 工具并保留执行实现：用户明确选择完整删除，因此不采用。
- 删除专用工具后让外部文件只经 Shell：用户随后要求也可使用 `read_file`，且 Windows 当前没有正式 Shell 后端，因此合并只读入口。
- 让 `write_file/edit_file` 同时获得外部写入：不属于当时确认范围，因此当时保留 Shell；用户后续明确要求 Full 支持统一文件工具后，按上方新决定实现，未改变其他审批模式的 Files 范围。
- 同时删除三个检索工具或 MCP 工具：用户选择先保留检索并评估替代，MCP 只要求用途评估，因此保持。

MCP 来源目录／连接与按需工具发现仍用于配置来源、延迟接入远端工具，资源与提示词则服务声明这些能力的 Server；它们不是文件工具或远端 tools/call 的重复入口，本次保留。现有三个检索工具也保留：后续可在稳定参数与结果合同下评估 `rg --files`／`rg --json -F` 后端，但不能把 `rg --files` 当作列目录的等价替代，它不会列空目录；还须处理 ignore、分页和正式制品内的可执行程序供应。Windows 当前无正式 Shell 后端，直接移除会丢失内置检索能力，本次不实施替换。

成熟实现对照：[Pi 默认 reader](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/tools/read.ts)使用普通文件读取；[OpenCode](https://opencode.ai/docs/permissions/#external-directories)将外部目录交给统一权限；[Claude Code](https://code.claude.com/docs/en/permissions#symlinks)检查请求与实际目标；[Gemini CLI](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/tools/read-file.ts)调用集中路径验证。这些实现并不采用相同的默认策略；本次采用的是用户确认的职责划分，不推定所有 Agent 都无额外防护。

## Consequences

默认工具数量变为有 Shell 时19项、无 Shell 时14项，外部读取使用已存在的 `read_file`，不增加新名称。旧 Workflow 配置不再有执行意义，但其原字节仍可备份／恢复；旧记录不能从今天的目录重新取得执行资格。

[退役回归](../../../../apps/service/test/isolated/tool-retirement.test.ts)沿实际 Runtime 核准确旧配置、旧激活与零模型／子任务效果；[统一外部读取](../../../../packages/agent/test/isolated/files/external-file-reads.test.ts)核分页、无外部基线、硬链接正常读取、私有实际目标、完整大正文和取消；[Service 回归](../../../../apps/service/test/isolated/configuration.test.ts)核实际模型名称与外部正文／项目说明边界。当前产品与实现归[工具手册](../../../../docs/handbook/features/tools-and-approvals.md)、[扩展手册](../../../../docs/handbook/features/extensions.md)和[Files owner](../../../../packages/agent/src/tools/files/README.md)。

## Verification

2026-11-02，Windows x64／Bun1.4.3，在 `840f71b31` 的任务工作树实施；主分支同期的 Desktop 链接修复 `0dc1e3b7b` 独立保留。实际执行 `bun run typecheck`，八 workspace 及根类型检查通过；Agent build、统一 API 生成核对、Agent 边界、文档结构／影响、测试归属与计划证据门禁通过。

简化读取与原结果呈现／取消三份文件13项119断言通过；工具退役3项55断言、实际 Service 默认装配11项145断言、原生资产保护、普通 Skill 选择与目录、独立 Planning、知识关闭／冷恢复、CLI 参数及宿主、Client 和 TUI 回归分别通过。知识关闭夹具改用真实 Windows 私有目录而非 `mode:0700`，未放宽生产 ACL。默认检查点与 Fork 的完整回归通过。原 TUI paired／shared 两项实际键盘过程记录45个变化帧，对照原分支47帧，核目录、分页、刷新中切换、迟到读取隔离、重开、原草稿及正常退出；切换期间的清屏中间帧在原分支同样存在，这些结果不等于完整客户端视觉或发布验收。

扩展回归中以下既有失败均在未修改的主分支 `0dc1e3b7b` 对照复现：大文件 Runtime 的5秒时限、257次读取长任务的45秒时限，Skills／用户 Skill 目录的 Windows symlink 权限，以及 Cookie checkpoint 与 Session logs 的 symlink／私有 ACL 夹具前置。它们不是本次退役引入，不修改断言、增加等待预算或降低产品保护来取得通过；仍未取得这些完整文件的 Windows 资格。shared Skills 与 built-package 的现有平台 skip 保持。原始命令日志与 TUI 过程帧保留在本机 `.cache/tool-surface-prune-20261102/`，不作为跨平台或完整默认集证据。
