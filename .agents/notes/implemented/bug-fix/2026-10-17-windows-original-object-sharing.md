# Agent Note: Windows 原对象共享保护与 Native 配套进程归属

Status: implemented

## Problem

实际 Windows 反例发现，属性读取 HANDLE 指定 FILE_SHARE_READ 仍未阻止候选文件改写，普通祖先 pin 也未阻止重命名。仅通过元数据、ACL 或 Close mock 不能证明原对象在后续加载期间保持不变。原先要求读写权限的区域锁又与修正后的真正只读文件 pin 冲突。

Native 的 Node 适配器只接受 executable/entry 两参数，拒绝正式 Windows 的固定 Bun 配置参数。Node/libuv 还默认把普通子进程加入父进程拥有的 KILL_ON_JOB_CLOSE Job，Main 异常退出时 Service 被直接结束，来不及履行私有 stdin EOF 的资源清理。正式 Main 已持有独立原生使用权，但配套启动器仍尝试调用仅 Bun 可用的 FFI。

## Decision

候选文件 pin 请求实际 GENERIC_READ，祖先 pin 请求 FILE_TRAVERSE，再保持原共享模式。C 前门、Bun scope、私有复制/发布祖先、卸载祖先和 Node-API Main 采用一致的原对象保护；纯临时元数据探针不冒充使用期 pin。区域锁只请求 LockFileEx 所需的读取权限，保原 SH/EX、原 region、ACL、identity 和关闭未知持锁；UI SQLite 的读写 HANDLE 不随之改为只读。依据为 [CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew) 与 [LockFileEx](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-lockfileex)。

原生 scope 在持有原祖先后核每个 HANDLE 的准确最终路径，JS 不再预先逐叶重复 realpath；同步最终路径缓冲区复用，不暴露给调用者。完整内容扫描的无原生 owner 分支使用 native realpath；持有 genuine owner 的分支直接使用原 HANDLE 的已检查事实与完整读取，仍逐项核 single-link、库存、大小与全部 SHA，不增加内容缓存或豁免。临时探针权限、同进程复用与构建物化的后续决定见[准入成本](2026-10-17-windows-bundle-admission-cost.md)。

完整 Native 安装的长 npm 路径在 Electron Main 中暴露 Win32 MAX_PATH 拒绝；Node-API 只在系统文件调用边界为已经校验的本地 DOS 路径添加内部 extended-length 前缀，不依赖宿主 EXE 或机器 longPathAware 设置。原调用者仍不能传 device/UNC、相对或歧义路径，原最终路径与 FileID/ACL 比较不变；证书 named pipe 使用独立原命名空间，不套此转换。不修改上游 Electron manifest、注册表或安装 ACL，依据 [Microsoft 长路径规则](https://learn.microsoft.com/en-us/windows/win32/fileio/maximum-file-path-limitation)。

Node 配套适配器只额外接受从同一候选 runtime 目录导出的四个准确固定参数，拒绝额外、分离或改投配置路径。Windows Service 使用 detached 创建以避开 libuv 的强杀 Job，但保留原私有 stdin/双输出管道和唯一 paired 生命周期；不 unref，不把断连当清理完成。[libuv 原实现](https://github.com/libuv/libuv/blob/v1.x/src/win/process.c)解释默认 Job 的所有权，实际原父 HANDLE 结束后的 EOF、清理 barrier 和自然退出由测试核对。

正式 Main 经原两跳证书、双 SH、全文件 pin 和完整内容复核后，才可向可信 `retainWindowsArtifact` 装配端口提供同进程借用。该端口不来自 JSON、HTTP、Model 或配置。WeakMap 只接受工厂产生的原 live owner，并绑定原候选 root/digest、Service entry、Bun 和 build；复制/伪造/closed 对象及改投均拒绝。借用未归还时 Main close 拒绝；paired 只在原 child exited 兑现后归还，退出未知保原借用。Service 自己仍使用独立 Bun 准入，不借父证书、父使用锁或内容缓存代替。默认 Bun 宿主继续走原准入。

完整 Main 计时显示三次 Node 内容扫描各约 1.3 秒，另有实际 Node-API 独立文件准入。现在初始 Node 完整语义／内容验证保留，native factory 仍独立核每份原文件 SHA 并把原 native manifest 摘要绑定实际候选 ID；新增闭合文件／目录库存，在每次原 owner verify 中重新枚举，拒绝新增未知项、缺项、改类型和 reparse，声明空目录也必须准确。持续的原 read/no-write/no-delete pin 保护已核字节，原 identity、有效 ACL、双 SH、证书与关闭合同保持。Main 完成这次独立准入后复用其 genuine owner，不再无 owner 地重复扫描同一闭包两次；子 Service 仍独立完整准入。Node-API 采用静态 CRT 和 `/O2` 正式编译，不添加测试 export 或运行期编译入口。

## Alternatives considered

- 保属性 HANDLE 或只增加事后 hash：不能保护验证到加载之间的原对象，实际改写/重命名反例已否定。
- 放宽候选 pin 的 write sharing：让数据重新可写；改为区域锁仅请求必要读取权，不放宽文件 pin。
- 保 Node 默认 Job 并把子进程 dead/0 计作正常清理：真实反例中没有清理回调，退出码0不足以证明 EOF drain。
- 在 Main 加载 Bun FFI 或另造父 helper：与实际 Node runtime 不兼容，也会引入另一所有权。复用本 Main 的原生 owner，并明确借用依赖。
- 跳过 child 独立准入或延长正式安装门禁：都不能建立原发布资格，未采用。
- 仅靠目录 FileID 声称库存未变：原目录允许创建子项，不能据此省略闭合库存；采用原文件 pin 加每次重新枚举，并用持续活句柄时新增文件／目录的反例核实。

## Consequences

本决定修正原对象保护和 Native 创建/关闭接线，不授予 publisher、完整 Windows 安装、窗口/维护恢复或其他平台资格。实际全量制品、回归结果与仍失败的门禁分别归 [Terminal owner](../../../../apps/cli/docs/terminal-release.md#windows-managed-terminal-当前实现)、[Native owner](../../../../apps/desktop/docs/native-release.md#windows-managed-native-当前实现)；不能把有限 owner mock 或实际 Node 探针当完整 installed 通过。

Bun完整文件scope的只读目录pin仍允许新建子项，其后续verify会因原目录stamp变化拒绝；不能把任意目录HANDLE推导为完整库存永不变化。跨await的原对象/目录与完整库存复核仍保留，未以本次读取权限修正为由删除验证或引入内容缓存。原启动/清理同时失败时Main保两项原cause及rejected opening，防止错误覆盖或自动新启动。
