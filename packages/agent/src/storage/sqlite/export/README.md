# Session 只读记录导出 owner

[具名实现](../session-export.ts)和 [Runtime](../../../runtime.ts) 提供 `beginSessionExport`、`readSessionExportPage`、`readSessionExportText`、`verifySessionExport`。入口核固定 Store、真实 root Session 创建主体以及子 Session 的实际 child.start／carrier／parent 关系。公开直接 child 导出拒绝；从 root 导出其真实执行组。历史查询不获取 owner、不安装扩展、不读取当前 Provider/config/vault、不调用模型、恢复、消费结果或派发工作。

Manifest 保存同一 Worker 读实例、业务变更水位、本 SQLite 连接的数据版本，以及闭合 section 的原持久 rowid 高水位和数量。`seq` 只表示该 section 的排序键，不是业务消息 seq；业务 seq 在对应 envelope 中另行保留。全部计数和水位采用 Decimal64。每页与最终验证在短只读事务重新核真实范围和完整 manifest；缺 section、改计数、Store／主体变化或观察到的提交使本次导出失败。换 Worker 或冷重开要重新 begin。没有长写事务、全库巨量 JSON 或新基础表。

该机制保证完成验证时读到的 SQL 记录集合与冻结清单一致。业务写由 change cursor 核对；`data_version` 还检测本连接可观察的其他连接提交，但不声称监控任意不合作文件修改。任何同 profile 业务提交均可能保守中断导出，调用者可重新 begin。最终 verify 不是“客户端已经收全”的证明：下载方仍须逐 section 校验顺序、数量、固定上界和完整正文，途中失败不能产生有效完成 footer。

各 section 使用显式安全字段映射，保留原 kind、content version、revision、origin 与未解析 JSON 文本。未知 Part、扩展未安装或未来内容版本都不要求 renderer 或业务解码；原字符串中的空白不会被 schema 清理。owner／锁权威、Run/child 私有配置、宿主配置/凭据、权限 grant、profile/Workspace 私有配置正文排除，manifest 明确列出范围。记录的用户／工具正文属于用户显式导出的历史；本功能不扫描或重新解释其中的指令。

`runs` 原始 envelope 同时保留起源 `context_selection_id` 与 `initialization_state`（unstarted／started／completed），供下载方核对原上下文选择与初始化结算事实；它们由具名 Run 创建和初始化事务保存，不授予执行／恢复资格。`run_resume_lease_json`、`job_recovery_lease_json`、Execution 的私有 `recovery_manifest_json` 仍在显式字段映射之外；原始导出不携带当前 owner、OS 锁或可转用的 purpose lease。Run 私有配置正文继续排除，reconciliation Command 的原私有输入、关联与配置仅保留摘要。

`extension_records` 同时保留原 `fork_provenance_json` 文本，供下载方识别已派生的历史来源而不重授执行资格；该字段与业务 `json` 使用相同的超过 64KiB 分块读取和 EOF/hash 校验，不隐去未来 provenance envelope。

每页最多 200 条，默认 1MiB、最大 8MiB。原文本超过 64KiB 时由第一层真实字段的 `export_text` 引用替代，包含原字段、UTF-8 字节数和 SHA256；不能扫描用户 JSON 中同名对象当作引用。`readSessionExportText` 只接受该 section 已声明字段与实际原行，在同冻结读集下用 SQLite BLOB byte substring 返回最多 64KiB base64，完整 EOF/hash 才证明无损文本。页预算不足明确报错，不截断为完整记录。

Artifact section 保存真实 blob_ref 与 blob 的 hash、大小、媒体类型、原 Store/Session/subject/scope。它不是正文已下载证明；完整 Model/Artifact 由已有准确原 scope reader 另行读取，并独立核 EOF/hash。Fork 的 `fork_source_message_id` 与压缩原来源必须通过已有 SQL origin reader 核关系，知道 hash、Part JSON 或 renderer 路径不授读取权。不能据 SQL footer 声称跨 DB／文件介质原子快照。此项不是备份、恢复、GC 或 namespace copy/rebuild。

[实际测试](../../../../test/isolated/export/session-export.test.ts)覆盖真实 Model/Tool 写入 210 条记录、固定页完整性、实际同 Loop 子执行组、跨主体／Store／child 拒绝、篡改清单、业务提交和外部 SQL 提交竞态、冷只读零 Provider/写入、未来扩展原 origin、超过 2^53 排序键、9MiB 未知原文分块与准确 hash，以及通过原 scope reader 读取完整 17MiB Model 结果。原始错误和中途取消不会被测试包装为已完成导出；公开下载／客户端完整 footer 由上层独立验证。

恢复后的原始记录导出以新 Store 作准入和冻结清单身份，root 创建命令仍核原主体，child.start/carrier/原 Command 保持准确父子、rootWork 与一致原出处。各行原 `origin_store_id` 不重标；读取不会恢复旧执行。[实际恢复回归](../../../../test/isolated/restored-media/read.test.ts)核新清单身份、原 Artifact 出处和完整 verify，[子执行组回归](../../../../test/isolated/model-output/child.test.ts)核恢复后的原 child 组。
