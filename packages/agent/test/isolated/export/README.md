# Session 原始记录导出测试

[session-export.test.ts](session-export.test.ts) 使用私有临时 SQLite、实际统一 Loop、固定 Model、可信 child 配置和真实 Artifact。一个普通 Tool 经公开 records API 登记 210 条真实记录，验证超过首 200 条的完整分页，不以 SQL 造执行回执。未来 Part／扩展的直接 SQL fixture 仅用于内容兼容与故障边界，不能授执行资格。

测试核原始文本空白、content version、原 origin、严格 Decimal64、9MiB raw 字段完整分块/hash、17MiB 原 Model 正文的独立 scope 读取；业务修改、清单篡改和其他 SQLite 连接提交后必须拒绝完成验证。冷只读与各页观察不调用 Provider、不消费或恢复旧操作。Core 的 SQL 验证与上层完整下载/媒体 EOF 是分别验证的范围。
