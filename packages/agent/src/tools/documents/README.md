# 内置办公资源和 PDF

## 内置 Office Skills

Kite 随包提供 `docx`、`xlsx`、`pptx` 和 `pdf` 的正文、脚本、模板与许可。各项沿原 Apache 2.0 许可分发。Word 脚本的默认批注作者为 Kite，该脚本注明了修改。 [随包资源](../../../assets/office) · [上游提交 1780c5e5](https://github.com/anthropics/skills/tree/1780c5e5a552fd4d1c9d6a7b0cab26b0c2bef064/skills)

构建逐项核校清单里的字节和摘要，将资源复制到 `skills/office`。知识源按 `builtin:office.<格式>` 提供固定正文与清单内资源，并在正文补充只读资源目录、原件工作副本及 `KITE_OUTPUT_DIR` 的用法。用户选定的 Skill 使用受管 Shell 中已授权的工具和依赖。 [资源清单](../../skills/office-manifest.json) · [构建](build-assets.ts) · [知识源](../../skills/office-source.ts)

## PDF 制作与交付

受管 Shell 可用已有 Bun 调用 PDF helper。`--input -` 可从标准输入读入 JSON。

~~~sh
"$KITE_DOCUMENTS_BUN" --no-install "$KITE_DOCUMENTS_HELPER" pdf --input spec.json --out "$KITE_OUTPUT_DIR/report.pdf"
~~~

成功结束的 Shell 将当前输出目录交给现有收集器。非零退出按原 Shell 结果处理，结果未知时先核原执行。需要重新导出时，从已核实的可用源文件出发，使用当前 Shell 的输出目录。 [交付 owner](../../business/output-collection.README.md)

[稳定导出](document-export.ts)用打开的 regular-file 身份、固定字节上限、读前后 size/mtime/ctime 核验和目标父目录下私有临时子目录中的排他临时文件；fsync 完成后排他 link 到最终名称，不覆盖同名输出。避免跨 Shell 临时目录与工作区进行硬链接；失败或取消清理本次临时文件与目录，不删除目标。工作区中的新路径可作中间副本，最终交付使用 KITE_OUTPUT_DIR 中的新路径。源文件始终不修改。当前执行成功结束后的自动归档由 Shell 输出 owner 负责；helper 本身不保存 Artifact，不重试生成。

[PDF adapter](pdf-command.ts)固定 pdf-lib 1.17.1 与 fontkit 1.1.0。create 使用 A4、固定字号、随包 Noto SansSC 的 wght=400 实例子集、真实字宽换行和显式页面，超限返回 layout_overflow。merge 和 edit 支持页面选择（拆分、删除、重排）、旋转、文字/PNG/JPEG 叠加及 text/checkbox/dropdown/option-list 表单；页面重组与表单填写不能同时指定。不支持任意正文原位编辑、自动重排、HTML 转 PDF 或复杂跨页表格。

固定变量字体不能直接按默认实例子集化：fontkit 1.1.0 会把原字体的奇数字形偏移截为短 loca，文字虽可提取，页图却缺字。显式实例化重编码可避开此偏移问题，但 encoder 仍会漏写末尾连续 flag 的计数，导致 B/D/P/X/x 等空白。[随包补丁](../../../../../patches/@pdf-lib%2Ffontkit@1.1.0.patch)仅给 ESM/UMD 两个入口补齐该计数，沿根 patchedDependencies 和 lockfile 可复现安装，保留原 MIT 许可；不修改字体 hash、不引入运行时或构建依赖。[编码回归](../../../test/isolated/tools/documents/fontkit-subset.test.ts)独立读取合成 glyf，核无重复、255边界及跨轮廓的 flags、点数和坐标。官方 fontkit 2.0.4 的同一 encoder 仍缺该收尾，换版本并不能单独修复；同版本静态 OTF 的 CFF 子集也会产生无效字体警告。全字体嵌入对照约 11.4MB，不作为交付方案，修后两页中文长文仍是小体积子集。

## 固定资产与执行边界

标准 Terminal 和 Native 构建生成 PDF.js 分页 worker、PDF helper、固定 Noto Sans SC 字体和字体许可。构建将四个内置 Skill 的只读资源放入同一制品库存。Service 核过 helper 摘要后才登记 helper 与 Bun 路径，运行时读取字体时再核其 SHA-256。 [构建](build-assets.ts) · [运行时校验](document-runtime.ts)

Desktop 使用各格式的独立原件预览。PDF 页面与文字层由已核验的分页 worker 读取。 [Desktop 预览与验证](../../../../../apps/desktop/README.md#办公输出文件) · [PDF 分页缓存](pdf.ts)

## 验证

内置 Skill、源文件边界和排他导出由隔离测试覆盖。构建资源后运行 PDF 脚本可检查中文字符实际栅格、合并、页面操作、叠加、表单及溢出拒绝。 [隔离测试](../../../test/isolated/tools/documents/office.test.ts) · [PDF 实际文件冒烟](../../../scripts/pdf-documents-smoke.ts)

~~~sh
bun packages/agent/scripts/pdf-documents-smoke.ts
~~~
