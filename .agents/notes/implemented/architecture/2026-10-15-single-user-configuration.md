# Agent Note: 模型统一使用现有用户根目录配置

Status: implemented

## Problem

新桌面设置缺少原模型列表，默认 Service 还从所选 Profile 的 config.jsonc 装配模型，导致已有用户文件中的提供商、启禁和默认选择不可见。项目模型覆盖又使同一设置随当前会话改变。用户明确要求模型统一使用 `~/.kite-code/kite-code.jsonc`，并移除 `unified-agent/default/config.jsonc` 的运行配置逻辑。

## Decision

Service 的私有 [user-configuration](../../../../apps/service/src/user-configuration.ts) 是默认模型配置唯一文件入口。它适配现有 provider/model/disabledModels，保留提供商 alias 与由 alias/name 生成的稳定 route ID；公开中立模型值供设置和实际 Run 使用。读取、模型启禁、默认选择及 Provider 保存使用同一文件；缺失或损坏不读 Profile 文件替代。项目仅继续提供受支持的非模型配置。

保存遵守原文件的字节 ETag、完整读取集和短锁原子发布，保留无关注释、字段、模型 metadata、未修改 key、嵌套 default route 形状和暂时不在目录的 disabled route。可信嵌入宿主与自有测试可明确注入任意配置文件路径，中立 models/modelId 形状仍可保存在这个文件；这不是生产目录发现或回退。HTTP、renderer、startup JSON 不能选择路径。

现有 inline API key 只在私有宿主实际运行/显式发现时解析，列表和 snapshot 只保 opaque reference。更换 key 后才保存用户级 OS vault 引用并去除该 provider 的旧明文，不自动迁移其他 key。模型 vault 使用 `kite-agent/user-models` namespace，保证各 Profile 对同一配置的引用一致；MCP 保留原 Profile namespace。paired child 有限环境携带宿主 HOME，Windows 同时携带 USERPROFILE，避免子进程回到另一用户目录，仍不继承模型 key 环境变量。

桌面模型分类挂载自动加载，沿用原分组列表、启用开关和默认菜单；Main、输入区、准备页、常规卡及 TUI/onboarding 都固定 user scope。原 Store/会话读取代次和原 mutation 身份继续核实；用户级未知写入阻止跨会话竞争写。历史 workspace mutation 仅保留原结果查询能力。

## Alternatives considered

- 保留 Profile config.jsonc 并迁移或回退旧用户文件：会维持两份模型 authority，切换 Profile 后可能继续读到不同值；用户明确排除此行为。
- 只改桌面列表的数据源：设置与实际 Run/TUI 可能仍读取不同文件，保存后的默认值也无法可靠生效，因此同步默认 Service 和所有当前模型调用者。
- 把现有文件整体转换为中立 models/modelId：会无必要地重写用户已有格式和 key。采用私有适配器，保留原文件；显式嵌入宿主的中立形状仍可使用。
- 模型凭据继续使用 Profile vault：同一用户文件中的新引用在另一 Profile 下无法解析，因此仅模型 vault 改为用户 namespace，避免扩大到独立 MCP 凭据生命周期。

## Consequences

项目模型覆盖退役，相关模型 API 和通用项目模型 patch 明确拒绝，客户端不再展示模型范围选择。工具、扩展及会话临时下一轮选择保留原负责范围。未选择有效路由时如实不可发送，不根据内置模型目录或凭据环境猜测另一 Provider。

用户配置父目录继续拥有原 Profile 私有配置的保护：默认 Files 读写、宿主 Shell 与 Workflow verifier 将它列入可信保护范围；Native 的文件打开与 Git 分支切换也避开用户目录。尚未首次创建的配置目录按最近存在祖先固定其 canonical 目标，不因缺目录失去保护或阻断正常启动。[真实 Files 请求](../../../../apps/service/test/isolated/run-model-selection.test.ts)验证 Workspace 包含用户目录时，配置不会进入工具结果或后续 Provider 输入。

根目录用户文件位于 Profile 之外。[原离线备份决定](2026-10-02-offline-profile-backup.md)关于 Profile 内配置原字节的归档/恢复兼容仍适用，但这些历史资产不再是运行配置；恢复 Profile 不覆盖全局用户文件或恢复 OS vault。当前 [maintenance owner](../../../../packages/agent/src/maintenance/README.md)明确这一边界。

现有测试的显式自有文件注入仍须保留，不能为缩小 diff 让测试回到真实 HOME 或给生产源增加 Profile 回退。跨 workspace 的 HOME／用户路径／paired spawner 只保留 [Service 测试辅助](../../../../apps/service/test/fixtures/user-configuration-fixture.ts)一份，由测试 subpath 共享；生产配置管理和 Skills 目录共用默认装配创建的适配器。Provider 新模型在同一批次分配身份，避免每个模型重复读取同一配置，仍按原读取集验证后发布。

[用户源测试](../../../../apps/service/test/isolated/user-configuration.test.ts)验证现有格式、原字节 CAS、字段保留、无旧路径回退和实际配对默认 Service 跨 Profile 同源；[实际运行测试](../../../../apps/service/test/isolated/run-model-selection.test.ts)以自有 loopback Provider 核用户默认、保存后的下一轮、实际 key/模型请求与项目污染拒绝。[桌面 DOM](../../../../apps/desktop/test/isolated/native-model-settings-dom.test.tsx)验证自动加载和原交互。它们不授予真实远端 Provider、OS vault 或其他平台窗口/安装资格。产品定义见[模型与配置手册](../../../../docs/handbook/features/models-and-configuration.md)，装配和 API 细节归 [Service owner](../../../../apps/service/README.md)。
