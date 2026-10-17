# Agent Note: 文件工具的路径、原生身份与默认目录

Status: implemented

## Problem

实际 Windows Native 会话把当前 Workspace 的绝对根路径传给 `files.list`，原 relative-only 文件引擎返回 `file_path_invalid`。模型随后省略 path 并成功读取空根目录，但 Native 只显示显式请求字段，导致同一工具行看不到读取位置。模型接收的 Workspace 信息采用绝对路径，工具 schema 却没有说明原路径限制。

后续外部路径回归复现：授权分类使用 Node stat 的 dev/ino，实际读取使用原生 volume／128-bit FileID，即使文件没有变化也报 `file_dispatch_scope_changed`。另一次按路径独立打开的复查不能证明实际 IO 选中的父对象。

## Decision

六个 Workspace 模型工具接受相对路径和已选择 Workspace 内的绝对路径。工厂提供纯 `relativePath`，在普通 Tool 实际 IO 与 checkpoint capture 前统一转换；基准固定为原 Workspace，Shell cwd 不参与。转换前拒绝 dot／dotdot 穿越，转换后仍按原相对组件和原对象 IO 验证，Windows UNC／设备／其他盘符和外部目标不获得范围。目录省略 path、空字符串与 `.` 表示根目录。

IO、字节恢复和持久 capture 保原相对路径合同，原调用／权限／审批记录不改写输入。绝对用户文件工具保独立 classifier、准确授权和外部 checkpoint 排除。Native 只在唯一可核实 `files.list@1` 原调用省略／空路径时显示 `.`；未知或歧义不补目标，也不产生文件打开资格。

实际 Windows 回归还暴露原相对发布通过 Win32 wrapper 返回 errno87。改用 `NtSetInformationFile(FileRenameInformation)`，继续从原 temporary HANDLE 向原父 HANDLE 相对 rename；不改为绝对路径发布或另建文件引擎。

上述发布修复的手写 Bun FFI 载体现已由 [cap-std＋napi-rs 决定](../architecture/2026-10-16-files-node-api-capabilities.md)替换，原 HANDLE 发布与路径／身份／展示合同继续保留。

外部路径的 classifier 通过 Files 引擎的可信 `inspectIdentity` 取得同一 native 身份；派发复查使用实际已锚定的引擎。该方法只检查严格 parent／file 元数据，不读取正文或增加 Model 工具；保完整 FileID、owner、单链接、准确原输入及全部 policy 证明。合法 Windows 大小写按原后端语义处理，受保护范围继续忽略大小写。

## Alternatives considered

- 只补描述，要求模型永远手动转换相对路径：可减少误用，但无法消除这次合法项目内绝对路径的失败，不采用。
- 底层直接接受任意绝对路径：会混淆 Workspace 与外部文件权限和 checkpoint 范围，不采用。
- 在 Native 没拿到 path 时无条件补当前工作区：可能把缺来源、重复 call ID 或未来版本解释为已知操作，不采用；只采用准确已知版本的默认语义。
- Windows 发布退回普通绝对路径 rename：会放弃原父对象绑定，不采用；保原 HANDLE 的 native rename。
- 删除身份比较、把 128-bit FileID 截断成 Node ino，或只凭路径相同放行：会掩盖真实对象替换，不采用；授权与读取使用同一后端提供的完整身份。

## Consequences

模型无需从系统提供的绝对根路径手动推算相对路径；结果和检查点仍有同一个相对目标。接口多一个可信路径转换方法，metadata-only 工厂提供明确不可执行实现，不引入 Model 可选 root、第二套权限或持久格式。

外部授权分类现在实际打开并关闭原生父目录／文件以取得元数据；派发复用自己的父目录 owner，读取仍核完整正文与 baseline。分类不再依赖 Node 与 Win32 元数据格式偶然一致；既有 Windows 审批摘要发生身份变化时须按现行请求重新核对，不迁移为新的授权。

现有 [Windows 原 HANDLE 提案](../../proposed/architecture/2026-10-10-windows-workspace-files-owned-handles.md)的完整资格要求继续适用，不因本轮有限用例改为 implemented。实现、实际 Windows 用例及剩余客户端／安装范围归 [Files owner](../../../../packages/agent/src/tools/files/README.md#模型工具路径)，显示范围归 [Native owner](../../../../apps/desktop/README.md#原工具过程与结果阅读)。
