# Agent Note: Native 原生缩略图与有界派生缓存

Status: implemented

## Problem

用户要求多张图片在性能较弱的电脑上预览时减少阻塞，确认使用浏览器原生API，并要求缓存以免频繁转换。原输入区与历史卡片直接将原图交给img；CSS缩小不生成小尺寸资源，现有串行读取也不覆盖浏览器解码。原DOM缓存按图片编码字节计量，无法表达高像素小文件的展示成本。只把每次显示改成缩放，又会在滚动、切换和重复选择时重新解码。

## Decision

- [窗口附件owner](../../../../apps/desktop/src/native-input-images.ts)按bridge／generation／当前Store拥有一个[派生缓存](../../../../apps/desktop/src/native-image-previews.ts)，输入区与历史消息共用；原范围结束或窗口卸载清除，不持久化跨窗口图片。缓存只保存派生Blob与尺寸，不保存原图、URL或读取资格。
- 输入File先核SHA，历史仍完整经过原Main准入、大小／EOF／SHA验证，然后才查询派生缓存。内容hash、媒体类型、字节数与固定转换版本决定结果相同；viewSelection／historyEpoch变化继续控制原读取取消，不迫使相同内容重新转换。相同内容缓存不成为新Session、Artifact或模型的授权。
- [静态Worker](../../../../apps/desktop/src/native-image-preview-worker.ts)使用createImageBitmap、OffscreenCanvas及convertToBlob，保持比例、长边最多512px、不放大小图，WebP质量0.8；原生编码不支持WebP时允许PNG结果。保EXIF方向与透明度，GIF仅取静态首帧。单个Worker串行转换，绘制后close原Bitmap，结束后清Canvas；空闲5秒终止，缓存命中不启动Worker。
- 同图在途请求合并。取消仅移除原调用者；最后一个调用者取消才终止活动Worker或删除排队项。清scope撤销全部任务，迟到Worker答复不能发布。完成时移除回调与原Blob闭包，失败结果不缓存。
- LRU最多128项，缓存所持Blob按编码字节＋宽×高×4估算合计32MiB；待转换原始输入最多8项／32MiB，包含活动转换。预算约束此缓存的估算载荷，不承诺原图解码临时峰值或浏览器总heap。首次生成仍需解码一张原图。
- 显示URL仍由原草稿或Conversation缓存entry管理，离屏、隐藏、移除与淘汰继续释放；历史图片登记给原DOM预算的成本改为缩略图字节＋RGBA估算。小尺寸派生Blob可以在URL释放后留在LRU，稍后原读取核验成功时免重新转换。输入预览失败仅提示预览不可用，不改变原图片暂存、Artifact与模型字节，不阻止已准备原图的发送；历史可显式重试。

本篇部分更新[缓存视觉与资源生命周期](../bug-fix/2026-10-19-conversation-cache-visual-resources.md)中的原图URL与编码计量策略；原窗口／Session隔离、当前gate、URL owner、可见性、DOM复用及资源回收理由继续适用。[初版DOM缓存](2026-10-19-native-conversation-dom-cache.md)的条数／DOM节点预算与原读取准入不变。

## Alternatives considered

1. 仅用CSS尺寸、lazy或async提示：不能生成缩略图，也不能确保小尺寸解码成本。
2. 主线程Canvas每次缩放：重复绘制与编码会争用输入和消息渲染；采用单Worker并复用结果。
3. 只缩放而不缓存：离屏重入与重复选择仍反复转换，不能满足用户要求。
4. 无界保留原图URL或已解码图片：放大高像素资源占用，绕过原DOM预算；只保有界小Blob，URL继续归原owner。
5. 持久化跨窗口图片缓存：需要增加磁盘清理、格式版本与权限生命周期，本任务采用当前窗口的内存LRU即可满足重复显示需求。
6. 直接按hash跳过历史原图读取：会把派生显示与当前原读取资格混用；保留现有完整读取与校验，只缓存转换结果。

## Consequences

同一连接范围内的普通刷新、会话往返及重复添加可免重复转换；LRU淘汰、连接／Store／generation替换或窗口重载后会重新生成。GIF预览是静态图，模型与保存仍使用原始GIF。Worker不可用或失败时显示明确预览状态，不回退到大原图预览。

[缓存单测](../../../../apps/desktop/test/native-image-previews.test.ts)核合并、取消、迟到、LRU与预算；[真实浏览器夹具](../../../../apps/desktop/test/image-previews-browser-runner.fixture.ts)使用生产组件与原生Worker，核十张4000×3000图片、CPU减速、输入、缓存复用、原字节、透明度与EXIF方向。产品行为、命令、实际结果及平台限制归[桌面手册](../../../../docs/handbook/clients/desktop/README.md)与[Desktop owner](../../../../apps/desktop/README.md#markdown-与附件输入)，不以夹具取得完整Electron或其他平台资格。
