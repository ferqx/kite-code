# 离线备份验证

[caller-intents.test.ts](caller-intents.test.ts) 对应新增 closed manifest v4 的普通 caller 字节资产：完整 Plan 请求、Unicode/换行、draft、旧 Store 与 targets 在新 Store 恢复后逐字节保持；128条与10MiB的有限完整 JSON不被截断；重复/非法字段/格式/超额/链接/私密权限/no-follow能力拒绝；损坏正文即使清单 full hash 匹配也不发布恢复。旧 v2/v3 精确字段与物理白名单保持，原配置/偏好实际恢复仍逐字节相同。该测试不发送 journal 中请求，不能作为 CLI caller 强杀、在线 lookup 或自动恢复资格。

[backup.test.ts](backup.test.ts) 验证 [维护 owner](../../../src/maintenance/README.md) 的显式 SQLite/WAL 副本、媒体完整性和发布边界。所有数据和媒体在 owned 临时 profile 中创建；busy 使用实际第二进程持有同一个外部锁，测试结束停止该进程。

当前覆盖 WAL 最新事实、原 Store/origin、未知 JSON、Decimal64 业务序列、17MiB 完整媒体、缺媒体/链接/取消无有效候选、未完成 journal 拒绝及篡改检查。没有使用真实 Provider、用户凭据或旧数据；不单独证明完整恢复、GC、平台发行或电源故障资格。

制品子场景在 owned 临时目录 bundle maintenance leaf、按当前 build-assets 位置复制迁移 SQL，从源码树外以包名导入并实际执行 create/inspect。不会覆盖工作树 dist 或影响正在运行的配套 Service SHA。

[restore.test.ts](restore.test.ts) 对原 profile 使用明确已选备份和回退意图，验证新 Store/旧来源保留、旧 pending 工作封存、同 Store unknown 门禁、明确新工作、备份后外置真实 Tool 计数不重做。七个 SIGKILL 子场景（含 journal 清除后仍持锁）由真实第二进程停在内部有限持久步骤；普通入口先 busy、强杀后 journal 拒开，显式 complete/rollback 必须核对 ID、观察 digest 和完整目录内容。fault-injection callback 仅内部测试 seam，公开入口和配置没有注入环境开关。


[assets.test.ts](assets.test.ts) 通过 [真实Node fixture](assets-fixture.ts) 构建Desktop当前私有库owner与一次Bun同锁helper，在临时profile生成133草稿/unknowncreation；不是手写SQLite schema替代owner。分别核config原字节（包括损坏JSONC/未知字段/credentialRef）、UI格式与一致副本、精确tree/proof、冷读原UI身份和失败无ready。restore七个强杀窗口也携这些资产；Node正常读写持有效profile lease，维护测试不绕过准入。源Core/WAL和媒体断言保持。消费进程和所有临时资产均所属测试，无用户数据、vault或收费模型访问；平台发行与完整Node宿主生命周期由各owner验证。

恢复资产扩展使用精确 manifest v3，同时保持原 v2 白名单可读。真实 owner fixture 包括 Desktop v2 recovery_intents 和 CLI ui/recovery.json v1；原七个 SIGKILL 窗口随备份携带原与后续未决恢复意图，complete/rollback 分别核其记录数、原 Store/Session/Command 身份与零重标。格式/字段/phase/重复/超限/链接及声明格式与实际格式不一致均拒绝，失败保源字节，没有用伪 SQLite schema 替代 Node owner。


[desktop-answers.test.ts](desktop-answers.test.ts)与[真实 Node fixture](desktop-answer-assets-fixture.ts)验证 DB5/v7 的独立 answer_intents 资产：三种原答案、unknown、312022字节 Unicode/CRLF、原 SQL state 字节和 SQLite snapshot hash、原 IDs/subject/digests在新 Core Store 下冷读保持，HTTP为零。坏行/schema/phase/摘要/容量/UTF8/权限、未来 DB/manifest与旧版本伪装均拒绝；重算外层proof不能隐藏坏内部行。既有当前 Node fixture 改核实际DB5/v7，旧版本测试明确去掉 answer表获得DB4/v6，再逐层验证旧schema，不能仅更改version声明。


[mcp-selection-intents.test.ts](mcp-selection-intents.test.ts)与[mcp-selection-assets-fixture.ts](mcp-selection-assets-fixture.ts)验证新独立 `ui/mcp-selection-intents.json@1` / closed manifest v8。真实 CLI journal owner 在实际 Profile/data锁内创建原 user终结/workspace unknown；生产维护独立校验固定请求、完整 readSet、subject、两SHA、phase、128条/16MiB、fatalUTF8和私有文件合同，零CLI/UI/Client依赖。DB5/v8备份与新CoreStore恢复保原整字节；源外实际Node用原纯codec冷读，先挡foreign scope再允许任何查询，GET/POST零，未将元数据当Core receipt或恢复POST权。128独立Workspace unknown与准确16MiB完整保存；未来/伪旧版本、坏scope/readSet/内部摘要、重算外proof、重复/超额/非法UTF8/权限/链接失败保源。旧v2–v7、DB1–5准入不扩大；当前Node reader不代表TuiMcpPort完整冷lookup或Windows实际资格。


历史 v2–v13 资格的 [Node 资产 fixtures](assets-fixture.ts)明确保留 DB5 输入：实际当前 owner 关闭后，要求 DB6 的 configuration_intents/model_routes 都为空，才物理去掉新增表并标 DB5；有内容即拒绝，不静默丢弃。caller/answer/Files fixtures 同样使用此守卫，既有格式和全文断言保持。

[desktop-configurations.test.ts](desktop-configurations.test.ts)和[独立实际 Node fixture](desktop-configurations-fixture.ts)保留当前 DB6，不降级。公共备份/inspect/v14/新Store恢复核两个原设置GET记录、两个Session路由、七条完整原caller（含high/minimal）、原SQL字节与零HTTP。秘密/数组enum、重算内部SHA的错误effort类型、非法UTF8/route和重标旧清单仍拒绝、失败保源；不以外层摘要代内部grammar，不创建POST权。isolated测试各用独立Bun进程，避免不同SQLite引擎选择在同一进程混用。
