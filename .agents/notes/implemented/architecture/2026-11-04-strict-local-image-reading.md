# Agent Note: 本地图片的严格解码与持久视觉结果

Status: implemented

## Problem

模型工具读取图片需要同时解决路径与附件权限、真实像素交接和 native 解码的资源生命周期。仅返回路径不能让模型看到图片；把一次展示的缓存当作历史会在源文件删除、Fork 或冷重开时失效。已有 Canvas 在合成半截 JPEG/PNG 上能返回缺块像素，独立 Worker 也不能隔离 native 崩溃或提供 OS 退出证明。

## Decision

新增 `builtin.files/files.view_images@1`／`view_images({path})`，不改变现有文件工具或协议版本。读取复用真实 Files 和已选择输入的权限、原件 hash/size 与派发 revision，取得处理名额后才完整读取。PNG/JPEG/WebP/GIF 的完整容器与 Sharp 严格警告模式都须通过；固定 Sharp 0.35.5 在独立程序应用 EXIF、只取首帧、按公开预算生成透明 PNG。

程序只接字节，使用空 Bun/tsconfig、禁用自动 env 和安装，不让目录 preload／别名先于已校验入口执行。依据 [Bun 配置合同](https://bun.sh/docs/runtime/bunfig)，这不同于只校验入口文件摘要；源码树外的投毒用例已经先红后绿。Windows 用原 Job owner 的内存／进程限制与原 HANDLE wait/tree 证明，保留固定程序和 native 依赖闭包。监督隔离崩溃与资源，不扩大为文件或网络 OS 沙箱承诺。

退出证明失败必须能独立中断对旧输出／exit Promise 的等待：结算 unknown，保 owner 和图片名额，唤醒排队调用并拒绝后续读取。不能一边无限等待缺失证明、一边声称30秒预算有效。合成故障用例先物理清理自己的真实进程，再保留 adapter 证明，核这条保守路径；普通取消、超时、崩溃与资源耗尽分别验证真实退出和下一调用恢复。

原件与实际发送给模型的 PNG 均进入原 Profile 的内容寻址 Blob；前者保 Session 输入引用，后者保准确 Execution 引用。相同字节物理去重，权限和来源仍独立。历史/Fork/冷读复用保存的结果，不重新读取源路径。持久内容沿现有引用、备份和显式无引用 GC，不另建会过期的图片历史缓存；重复显式调用仍重新校验并处理。窗口缩略图仅承担显示。

沿既有 `modelImages`、完整 Artifact 和两协议编码传递像素；只对这个准确新工具版本实施32MiB历史展开预算，保其他入口原合同。Native 的成功计数来自原回执，默认展开可折叠缩略图，不以模型正文或缓存命中授予读取权。

单次查看扩展为互斥的`paths`（1至10张不同路径）或原`path`，版本保持1。完整有序路径和私有原件登记共同绑定派发revision；先整批分类，再逐项重核并串行读取／解码，避免逐张重查完整列表产生平方成本。仅保留最多16MiB待交付PNG，每张仍限8MiB，全部成功后才按序发布并返回；中途失败／取消不把部分图交给模型。已发布后的Artifact故障保原owner与未知规则，不反向删引用冒充事务回滚。Core只为准确新工具接纳10张，PDF／浏览器等仍保4张；历史32MiB预算保持。单图metadata与键继续可读，多图使用同序images数组。

工具模型名与内部标识按用户最终要求统一为`view_images`／`files.view_images@1`，公开工厂为`createViewImagesTool`；不保留旧名称别名、兼容分支或数据迁移。版本保持1，`path/paths`参数与图像处理合同保持。

## Alternatives considered

- 直接复用 Canvas：依赖最少，但实际截断样本仍可解码成功，不能把它当完整图片证明。
- 只使用 Worker：已有 PDF 路径可复用部分经验，但无法隔离 native 崩溃；超时 terminate 也不等于实际线程／进程已经退出。
- 解码后直接把 Base64 塞进持久 Tool 正文或只存路径：会复制大正文，混淆来源或依赖可变源文件；已有 Artifact／工具视觉链可保存准确结果。
- 批次部分成功立即交图：会让失败回执、成功计数与模型已见内容不一致；选择整批交付，保留明确顺序及可验证结果，总量失败不静默删图或再次降质。
- 所有图像统一新预算或引入通用格式协议：会改变已支持的用户图、PDF和浏览器合同；本次使用准确新版本的局部资源预算，不新增业务表或第二条模型链。
- 为普通图片另建磁盘解码缓存：尚无命中率证据足以抵消权限／配方／失效成本。Blob 去重与持久历史已经解决发送结果保存；有限性能数据不能推导必须增加可丢弃缓存。

## Consequences

增加 Sharp 与平台 native 分发闭包，构建和源码树外离线验证必须包含它们。高熵大图仍有较大的 PNG、Base64 和持久输入开销，独立子进程的512MiB限制不代表主 Service 的硬内存上限。实测促成异步 Artifact 写入和重复 Blob 完整回读按块让出，但保留原 CAS、EOF/hash/identity 与未知结果约束。

当前行为、命令、性能及未验平台归 [Files owner](../../../../packages/agent/src/tools/files/README.md#图片读取)，准确视觉来源归 [Model body](../../../../packages/agent/src/model-body/README.md#工具视觉结果)，显示与过程验证归 [Desktop](../../../../apps/desktop/README.md)。本次 Windows 开发验证不授完整安装、长期 SLO 或其他平台资格。[用户图片输入决定](2026-10-18-user-image-input-references.md)与[会话文件决定](2026-10-23-persistent-session-files.md)继续指导原入口。
