# Agent Note: 终端显示偏好由客户端宿主持有

Status: implemented

## Problem

新统一 TUI 尚未承接手册已有的 `/theme`、`/language`。主题与语言只影响终端呈现，不能借设置菜单改动模型配置、业务历史或权限。旧用户配置与新 profile 是不同数据基线，用户已明确无需旧数据兼容。保存失败后的显示必须保留已确认值，不能像旧语言提示那样宣称已经切换。

## Decision

CLI host 在已持有 profile 共享使用权期间读写 `ui/preferences.jsonc`，UI 只消费有限 preference port。封存文件 SHA revision；保存只允许 language 或 colorPreset 单字段，复用 Agent configuration leaf 的短文件锁、JSONC 编辑、fsync 和原子替换。缺文件为 system/teal/dark；损坏、非法值、不安全路径与写入失败局部报告，保留原字节和最后显示事实。基础 theme dark/light 从该文件读取，无新增命令。

偏好对同 profile 的终端生效，跨 Session 保持；另一个终端修改后须显式读取，CAS 冲突不自动重试。Service 的配置文件与业务 HTTP 不参与。system 使用宿主设备 locale，macOS 优先有界只读 AppleLanguages，再使用 Intl；固定语言不翻译 Model/Tool 正文、路径、命令或机器码。UI 的语义色与文案 context 重绘已有树，不重建 controller、历史或运行意图。

备份已将真实偏好文件纳入白名单，保留完整 JSONC 原字节，包括损坏文件以供修复；原草稿格式验证不放宽。尚未发布的新基线 manifest v2 增加必需偏好资产字段，缺字段明确拒绝，不隐式补成 absent。

## Alternatives considered

- 经 Service 通用配置 API：会把纯显示选择混进模型/运行配置 authority，当前无必要消费者，因此不用。
- 复制旧全局配置并继续读旧目录：用户无需旧数据兼容，且会破坏新 profile 隔离，不采用。
- UI 自行读写文件或修改终端全局 OSC palette：UI 不应持路径/锁，Ink 语义色已经足够实现已有五种配色，不引入终端全局副作用。
- 自建另一套原子文件框架：现有 configuration leaf 已有锁、CAS、JSONC 与持久发布，复用它并在可信宿主限制字段及私有路径。

## Verification

macOS/Bun 1.4.2 实际文件 5 项 63 断言、完整 TUI 44 项 350 断言通过，覆盖重开、旧 revision、损坏/不安全路径、原 live profile authority 与输入别名、保存失败/结果未知、迟到与原正文。实际 80×24 paired/shared PTY 2 项 14 断言通过，核对 ANSI 配色、中文与英文原文、同 profile 重启、文件故障、零新增业务记录/Model 及所属进程清理。维护与文件组合 32 项 400 断言含 7 个 SIGKILL 窗口的原/后续偏好字节；CLI 原维护 4 项 79 断言通过。根 26 workspace build/types、边界和 API 检查通过；最后 UI 单独构建亦通过。最终统一回归与完整 V1.3 状态以[实施进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)为准。

## Consequences

当前平台验证不能推导三平台文件安全或终端资格；system locale 的测试注入不能冒充另一操作系统。原子发布后无法确认时需明确未知并重读，不能自动再次写入。正式旧入口、Workflow 和完整发行包切换仍由总体 V1.3 完成定义约束。
