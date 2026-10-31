# Agent Note: 当前流式正文与历史摘要的正常前进

Status: implemented

## Problem

统一浏览器006普通构建的正常final窗口，在正文已可读、Run终态接管之前，PTS67.950及67.966667短暂显示“完整回复读取失败。”，并使阅读位置往返；右侧浏览器页面始终正常。该片未保存当时IPC错误码，因此不能把后来复现的码当作该次实测码。

只读复核发现Main与共享UI把稍旧的不完整Message摘要和稍后的实时正文GET严格比较。deferred复现中，正常content／reasoning追加或complete提交被误判身份冲突，UI实际显示上述失败；历史投影随后更新又清除错误。预览、完整正文与真正身份／完整性失败必须分别核实，不能隐藏错误字样掩盖竞态。

## Decision

仅对当前未完成、没有origin且尚无工具调用的原Message接纳已核实前进：Store／Session／Run／Execution相同，实际正文以旧预览为前缀，UTF8字节不倒退且确有追加或完成。Main的live preview只由自己已观察Message内部供应，不新增renderer许可或IPC字段；SDK schema、EOF、SHA、UTF8及取消／阅读范围继续核。共享UI再独立验证，未完成提示以实际已读快照为准。

旧complete、已有calls和封存origin继续按原摘要精确匹配。未完成快照不能携工具调用，完整快照仍须succeeded；foreign、改写、缩短、终态计数、hash与真实传输错误保留。接纳正常前进不证明Run已结束，不建立复制以外的执行权，不创建正文持久缓存。

## Alternatives considered

- 隐藏／延迟所有读取失败：会吞真实身份或传输错误，未采用。
- 放宽所有摘要或封存来源的校验：会把冻结历史读取成后来输出，未采用。
- 修改Markdown、滚动或动画来遮住跳动：没有处理错误来源，未采用。

## Consequences

正常前进不会插入错误说明并推动阅读位置；真实错误仍展示，完整正文与复制资格继续来自当前已核reader。此前006像素失败、模型请求失败及导航unknown保留，源码修复不追认旧录像或原结果。

## Verification

原deferred四个失败场景转绿，临时6项9断言通过；原共享UI与Native有限IPC文件扩至21项275断言及9项123断言，保原scope、取消、UTF8／EOF／SHA与真实错误负面。UI／Desktop类型、定向Biome及差异空白检查通过。实际修后Native完成切换仍须007新制品连续观察，不由受控结果代证。

当前实现与准确资格归[Desktop owner](../../../../apps/desktop/README.md)、[UI owner](../../../../packages/ui/README.md)和[跨包边界](../../../../docs/active/unified-agent-boundary.md)。Core结果、公共Tool／协议版本与持久格式未改变。
