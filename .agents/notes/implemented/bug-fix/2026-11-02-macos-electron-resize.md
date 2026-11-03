# Agent Note: macOS Electron resize 同版本合成修正

Status: implemented

## Problem

macOS Native 在真实系统标题栏双击与连续拖边时，Main 的 Root／Page bounds 已正确，父合成仍可能采用旧子 surface；即使聚合已经等到正确尺寸，WindowServer 画面仍可出现内部灰 L、右灰带及工具栏／网页边界不同步。应用层提前回调、最终尺寸正确或背景同色都不能证明中间画面同步。具体反例与观测范围由 [Desktop owner](../../../../apps/desktop/README.md#固定-renderer-布局收敛2026-11-02)维护。

## Decision

用户先授权隔离诊断固定 Electron44.3.0，随后明确要求“把优化后的代码合并过来”。当前将082有效组合接入 macOS arm64 的开发启动与新 Native 候选；依赖、工具／协议及manifest版本不变。Windows、Linux及macOS其他架构保原链路。

[源码补丁](../../../../apps/desktop/patches/electron-44.3.0-macos-resize.patch)记录两项配套改变：BrowserCompositorMac 的resize deadline采用默认等待；CATransactionCoordinator在保留测试guard和feature读取后进入既有SynchronizeImpl。全局CATransactionV2同时启用，使GPU保留V2的CA context路径，Main继续旧PreCommit／PostCommit和resize消息循环。不能拆成单开feature或仅修改等待策略：前者曾使zoom期间viewport只在起终点更新，后者仍有灰L。GPU路径由固定源码解释；既有trace没有逐次context ID／fence，不将其冒称为直接观测。

[构建准备](../../../../apps/desktop/scripts/macos-electron-runtime.ts)只接受已核SHA的原版44.3.0 arm64分发，在每次新建且完全独立的副本内写入两处已核指令并进行ad-hoc重签。修改后校验整个签名前payload，仅允许两处指令与codesign的三个大小字段变化，再核源分发不变和副本完整库存。开发副本归原开发目录owner清理；候选在SQLite探针和完整manifest前完成处理，最终签名字节与CodeResources进入原清单。不得原地修改node_modules、已有候选或安装目录。

[Main准入](../../../../apps/desktop/electron/macos-electron-resize.ts)在ready前核实际加载Framework路径、固定版本／架构、构建时完整SHA和已审payload，才选择配套feature；明确禁用冲突、半补丁、未知字节及错误加载均拒绝。没有证明的通用app-only fixture保持原版且不启用feature，不构成该优化的验收证据。诊断、录制、输入helper和模型请求隔离只在私有夹具中存在。

这部分替代[固定Renderer结构决定](../architecture/2026-11-02-browser-fixed-renderer-layout.md)中“引擎补丁仍仅隔离”的阶段边界。单一Root UI、Main几何owner、真实原页保留、页面与控制身份、取消与未知结果门继续适用；不恢复截图替身、主动冻结或旧Chrome展示层。

## Alternatives considered

- 只提前原生resize回调或调整JS几何：069已经让子geometry早于父新surface，父仍先采用旧子帧，不能解决该合成边界。
- 仅默认surface deadline：079b的实际父聚合全部选到准确新end，连续画面仍有灰L及灰列，不能独立采用。
- 单独CATransactionV2或默认deadline加原V2同步：080仍有灰L；081出现约330ms的viewport尺寸传播停滞，不能合入。
- 仿VS Code取消vibrancy并使用主题实色背景：083实窗对照中缺口变成同色L，旧内容尺寸未同步；不因此改变普通窗口材质。
- 普通resize暂隐网页、冻结旧图或加固定等待：会重新引入应用层绘制追赶和交接，无法由最终原页保留断言证明过程体验；当前保留同一真实页。

## Consequences

2026-11-03 开发启动优化保留上述准入；准备时将首次完整源库存传给私有副本处理函数，贯穿复制前、目标独立完整比对及最终源不变核验，避免在复制后重新建立源基线和重复扫描。公开 patch 入口仍独立核源。复制请求文件系统写时复制并允许普通复制回退，副本仍须独立 inode／单硬链接且字节完整；不以复制方式代替验证，不跨启动复用已修改 runtime。

该实现与准确原始Framework字节绑定；其他Electron构建不靠版本字符串或相同偏移猜测准入，未知输入失败。后续更换引擎必须重新核实现与验证，并遵守用户对具体版本升级的授权。启动会完整读取并核Framework，尚不作启动性能承诺。

本次为本机macOS arm64代码集成和有限实际过程验证；正式Developer ID签名、公证、完整安装维护、其他平台及整体浏览器过程体验未由此取得。旧制品保持原字节，必须重新构建并重启才使用修正。实际测试、连续画面范围、已有失败和未覆盖项归Desktop owner与[Native构建说明](../../../../apps/desktop/docs/native-release.md#构建与安装)，不以同版本标签替代证据。
