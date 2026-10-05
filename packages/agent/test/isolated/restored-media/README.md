# 恢复后的完整历史读取

[真实回归](read.test.ts)通过固定 Model、真实 SQLite Worker、ArtifactStore 与离线 backup/restore 创建新 Store；未伪造成功 Model 回执，也不使用用户 profile、系统凭据或远端 Provider。

原 Model 输出与 Tool UTF-8 正文各超过 17MiB，随后实际调用封存的 Model input 超过 34MiB。恢复后新 Store 仅作读取准入，原引用仍保旧 Store/Session/subject/scope。测试逐全文核 input/output/media，另用真正 readonly 冷 Runtime 读取并断言零 Model/工具重放。目录、冻结 raw export、原压缩来源、旧 Fork 与新 Store 下显式新 Run 的完整输入分别核实；压缩 root 的新 Run 使用真实原摘要。

错误当前 Store、主体、scope、跨出处拼接与重复发布旧 ref 均拒绝。同 Loop child 的原 input/output、carrier 正文、raw 执行组导出和恢复后新父 Run 另由[实际父子测试](../model-output/child.test.ts)验证；旧 planned/unknown、缺失 operation key 和备份后外部效果不重放由[原恢复回归](../maintenance/restore.test.ts)验证。读取资格不扩大执行、ensure、发布或 commit 资格。

本机 macOS、固定模型的验证不证明其他平台、外部模型窗口或发布安装资格；HTTP/Client 原引用出处交接由 Service/Client 与 root fullmanifest 测试独立验证。
