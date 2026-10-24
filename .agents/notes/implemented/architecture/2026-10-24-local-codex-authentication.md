# Agent Note: 只读复用本机 Codex 登录

Status: implemented

## Problem

用户要求 Kite 接入 ChatGPT / Codex，并读取本机 Codex 认证自动连接。普通 API key 不能代替订阅登录；直接把共享 token 导入配置会复制秘密，并使账户切换、轮换与用户偏好混在一起。

## Decision

正式本机宿主将 Codex 的 ChatGPT 文件登录和实际本地模型元数据作为用户配置的只读来源。账户与主体摘要生成独立 alias，模型 route 仍沿原 alias/name 算法；token 轮换不改路由，换账户不自动替换旧会话选择或明确默认。已有手动默认优先，没有手动模型时采用本机明确选择。默认启用自动来源不写配置或联网发现。

自动连接在现有提供商页展示，由 Codex 管理登录和目录，不能经普通表单更改 endpoint、key 或删除。模型开关、默认和 effort 继续保存原用户偏好字段；虚拟 provider 不物化，也不保存 access/id/refresh token。损坏的 Kite 用户配置仍拒绝解析，不能借自动来源覆盖原字节或回退。

Service 私有 transport 复用现有 SDK Responses，只向固定 Codex URL 发送，并拒绝重定向；每次实际发送前重新核同一账户和有效期。Codex 继续拥有登录和刷新，Kite 不使用 refresh token、不写共享 auth，也不为失败请求切模型、协议或去掉显式参数。与原[Responses 决定](2026-10-15-explicit-responses-protocol.md)共享唯一 Agent Loop、工具授权、取消和私有 continuation；Codex 以认证来源路径及完整账户／主体摘要代替原 bearer 绑定，使同账户 token 轮换和冷重建保留原 encrypted reasoning。endpoint、模型、账户 header 和来源变化仍隔离；普通 Provider 保留原凭据绑定，不能借此选项跨凭据回放。来源对无效可选目录不产生保护路径，避免污染普通 Provider 的 Files/Shell 启动；合法但缺失的认证路径仍受保护。

认证文件采用可信 `protectedFiles`，与严格接受目录的 `protectedRoots` 分开；缺失或轮换的秘密名称不作为启动资产读取／hash。macOS 在原 Shell、Workflow verifier 与补偿中保护准确名称和父目录。把 auth 文件塞入目录列表会使普通 Run 在 Shell 准备时拒绝，删除保护或放宽目录身份检查则会暴露凭据，因此保留两种明确的路径语义。

## Alternatives considered

- 启动时把连接和凭据持久导入 Kite：读取产生文件写入，还需要解释重复导入、移除和共享 token 轮换；选择无写入的来源投影。
- Kite 自行刷新并回写 Codex auth：与正在使用登录态的 Codex 争用刷新凭据，扩大共享文件写入责任；保留 Codex owner，过期明确失败。
- 另起 Codex Agent 或执行循环：会形成两套工具、权限和历史 authority；只复用模型传输。
- 复用普通可编辑 compatible 连接：本机 bearer 可能被发送到用户配置的其它地址；采用固定 Codex family 和不可编辑连接。
- 预置模型名称或联网发现整个目录：会把猜测或冷读取变成实际能力；仅用本地明确模型和可见缓存，远端可用性仍由真实请求确认。

## Consequences

当前只支持文件缓存，未覆盖 OS keyring/ephemeral 登录或新的直接 SIWC grant。自有配置文件的嵌入宿主显式注入来源，中立 assembly 模型仍由宿主控制。缓存元数据不证明账户 entitlement；无法识别的不透明 cache identity 不被猜测成账户证明。显式 `maxOutputTokens` 不能在 Codex backend 表达时本地拒绝。

Linux 最初因未取得运行期认证保护资格而拒绝含私有文件的 Shell Job；该临时拒绝现由[专用认证目录隔离](2026-10-24-linux-codex-shell-isolation.md)替代。拒绝精确 file bind 的理由仍适用：宿主刷新可移除该挂载点，启动 proof 不证明持续保护。新的目录准备与无效布局边界不改变本记录的只读来源、认证刷新 owner、固定 endpoint 或账户路由决定。

实现和验证分别归 [Service owner](../../../../apps/service/README.md#本机-codex-来源)、[模型手册](../../../../docs/handbook/features/models-and-configuration.md#chatgpt--codex-本机自动接入)、[认证测试](../../../../apps/service/test/isolated/codex-auth.test.ts)和[集成测试](../../../../apps/service/test/isolated/codex-connection.test.ts)。本机受控测试不替代真实账户或发布资格。
