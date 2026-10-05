# Agent Note: 默认文件检查点保原模型来源与当前恢复授权

Status: implemented

## Problem

代码恢复需要准确原输入边界、完整修改前字节和当前物理文件基线。当前 Session view、相似 source ID、nullable Execution delivery selection 或成功 Tool 显示不足以证明原 Model 消费了什么。离线 profile restore 产生新 Store B 时，原 Model/Tool/Artifact 必须保持 Store A；混淆原来源、当前读取和新恢复授权会拒绝合法历史，或错误继承旧执行权。

本决定只覆盖同 Session/Workspace 的默认捕获、历史来源核验与 code-only 恢复。Fork 后节点、客户端三种范围与组合恢复仍遵循手册；当前实现和证据归 [checkpoint owner](../../../../packages/agent/src/business/file-checkpoints/README.md) 与 [Service owner](../../../../apps/service/README.md)，不由 implemented 推定后续部分已交付。

## Decision

Files 独立 leaf 在普通 write/edit 前后捕获 point/head/path，保存完整 execution-scoped binary preimage、实际 first/last/pending source 和物理 root/baseline。纯全局 metadata factory 唯一注册普通 Tool；每次实际 scope 才解析可信 Workspace、Profile 和真实 loader inventory，开启 protectReads 并独立关闭 FD。保护精确组件路径；完整 terminal root 只来自独立 verifier 和实际 shared lease，任意 custom 单文件父目录没有该资格。

可信默认 helper 核原 Tool 的 model_decision、成功 Model 的完整 sealed input/hash、原 Command/subject/Run 和 Run 已固定的 selection。用完整实际 selected Message 与消费 User 的 source IDs/正文取得原 trigger/before boundary；已发布 compression 递归核完整原 input/output/origin。前缀只是候选，真实 User 的 compression ID/正文碰撞保留，只有 Core 实际附加的 instruction 被排除。后来 User 与 nullable Tool/Model delivery selection 不改旧边界。

当前 observation/typed reader 使用实际 Store B；每个历史 point、Tool、Model、Command、Run 和 Artifact 保各自原 Store。live capture 只能来自当前 Store；历史 source 核原 point Store并逐项核实际 receipt。selected point 可以聚合原 A 与新 B 的连续文件链，每条 source 都单独验证；不能以同 Store 或 known ID 代替证明，不为恢复重标数据。

恢复是当前 Store 的独立普通 Action。默认 full 仍单独请求人类 Ask，不重用 Model/Tool/旧 Store approval；原 context/group/records 的 final SQL guard 与 Workspace serial lock各自负责准确范围。原 baseline、完整 Artifact EOF/hash/size 和 current last baseline 都须匹配，逐文件 durable journal 在 I/O 前保存，发布后无法确认保 unknown。相同 restore ID/原 Command 的 cold 查询只读，不再写文件，不宣称批次原子。

## Alternatives considered

- 仅提供 readBytes/restore/remove 原语：不能代替恢复点、原消费输入和停止组最后门禁，业务 leaf 与通用 Core guard分别实施。
- 以当前 view、ID/hash 或 Execution.contextSelectionId 猜原 Model边界：普通 Tool/Model 该字段可为null，later User和compression改变视图；改用封存 Run selection及完整原 typed body。
- 按 compression ID、前缀或 instruction相同正文过滤 User：真实User可撞名，使用实际typed compression relation并保全文。
- 所有历史来源必须等于当前 Store，或重标 A records/media为B：真实backup/restore后合法媒体仍A，前者错误拒绝，后者丢scope并混旧执行权；当前reader/新Action与原source分开核验。
- 直接调用文件原语并复用原批准：无法保护Ask等待期间原上下文/读集及当前人类决定；独立ordinary Action/Ask、最后SQL guard和逐文件journal不可省略。

## Consequences

证明预算为8192完整selected Message、64MiB累计来源、8MiB单页、32层compression、16MiB单preimage；超限明确不可恢复，不裁剪成完整结果。捕获不归档Shell或外部editor。foreign scope、unknown capture、实际postimage漂移及不完整媒体拒绝物理写。Workspace锁不锁非合作编辑者，anchored FD不宣称跨文件或rename竞态原子。

真实macOS/Bun默认paired Main：两层显式compression/用户碰撞与恢复三文件6/259；公开offline backup/inspect/restore A→B、新B普通Run、两Store原来源/连续baseline、原184003字节BOM/CRLF preimage、早A点当前B独立Ask及两创建移除、cold零Provider/文件/cursor增长，单文件1/83，当前五文件19/506通过。foreign Session确切artifact_scope_denied/checkpoint_not_found，真实postimage漂移Command rejected且零Execution/Ask/journal/效果。失败日志保留；不替代跨Fork、automatic compression、全部客户端、一般Shell或平台资格。
