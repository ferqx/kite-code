# 内置办公资源和 PDF

## 内置 Office Skills

Kite 从 OfficeCLI 上游提交 `5fbf766` 改编三个办公技能。随包的 `docx`、`xlsx` 和 `pptx` 与 `pdf` 位于同一级，分别对应配置 ID `office.docx`、`office.xlsx`、`office.pptx` 和 `office.pdf`。OfficeCLI 技能标注修改，办公资源根目录收录上游 `LICENSE`、`NOTICE` 和 `THIRD-PARTY-NOTICES.txt`。 [OfficeCLI 上游技能](https://github.com/iOfficeAI/OfficeCLI/tree/5fbf766408a9d55f02dc94874e48634999c854c2/skills) · [PDF 上游](https://github.com/anthropics/skills/tree/1780c5e5a552fd4d1c9d6a7b0cab26b0c2bef064/skills/pdf)

构建核对清单里的字节数与摘要，将资源复制到 `skills/office`。知识源按 `builtin:office.<配置后缀>` 提供校验后的正文和声明的文本资源。四个技能目录直接位于只读的 `KITE_OFFICE_SKILLS_DIR` 下。技能直接调用随包工具目录中的 `officecli`，编辑、保存和收集产物沿当前 Shell 的授权、进程监督和 `KITE_OUTPUT_DIR`。 [资源清单](../../skills/office-manifest.json) · [构建](build-assets.ts) · [知识源](../../skills/office-source.ts) · [随包运行时取舍](../../../../../.agents/notes/implemented/architecture/2026-11-18-bundled-officecli-runtime.md)

改编后的技能按 Shell 工具报告的环境执行，提供 PowerShell 和 Git Shell 示例。常规编辑通过 OfficeCLI 的单进程批处理落盘，跨调用复用工作区副本和 UTF-8 操作文件。可用的预览或查看器用于版面复核，结构校验读取退出状态和 JSON 结果。 [Shell 约定](../shell.README.md) · [交付约定](../../business/output-collection.README.md)

## 成品路径与交付

在工作区或用户指定的已授权位置保存并核验成品后，调用 `kite-documents stage --input <文件>`。该命令支持任何可交付的普通文件，排他复制到当前 Job 的 `KITE_OUTPUT_DIR`，并通过 stdout 返回 JSON。`absolutePath` 是实际源文件的规范绝对路径，`markdownTarget` 是同一路径的 Markdown 表示，使用正斜杠并转义有语法含义的字符。模型从本次 Shell 结果直接取得路径，将原样的 `markdownTarget` 写入 `[文件名](<路径>)`。暂存目录在归档后清理。原保存位置仍可由桌面按现有权限打开，文件卡提供归档快照。

Excel 编辑后，先在工作副本上复核重要汇总格。内置 XLSX 技能的 `verify-sum.ts` 仅支持用户任务中明确指定的独立同表整数 SUM，检查直接数值输入和预期值，通过已校验的文档 helper 识别目标单元格的 OOXML 公式结构，拒绝共享、数组、数据表或无法验证的结构。对于独立公式，使用宿主已校验的 OfficeCLI 重写未缓存的同一公式，再重新打开核对缓存；成功后排他发布新文件。原稿和通用 `stage` 不会重算或改写。OfficeCLI 保存时可能刷新或清除同一副本中的其他公式缓存，不保证其他缓存不变；交付前仍需核对其他重要结果。未通过或超出范围的公式保留原样，并在交付中明确哪些数字需要在 Excel 中重算。[XLSX 技能](../../../assets/office/xlsx/SKILL.md#verify-a-summary-before-delivery)

## PDF 制作与交付

受管 Shell 可用已有 Bun 调用 PDF helper。`--input -` 可从标准输入读入 JSON。

~~~sh
"$KITE_DOCUMENTS_BUN" --no-install "$KITE_DOCUMENTS_HELPER" pdf --input spec.json --out report.pdf
"$KITE_DOCUMENTS_BUN" --no-install "$KITE_DOCUMENTS_HELPER" stage --input report.pdf
~~~

成功结束的 Shell 将当前输出目录交给现有收集器。非零退出按原 Shell 结果处理，结果未知时先核原执行。需要重新导出时，从已核实的可用源文件出发，使用当前 Shell 的输出目录。 [交付 owner](../../business/output-collection.README.md)

[稳定导出](document-export.ts)用打开的普通文件身份、固定字节上限、读前后 size/mtime/ctime 核验和目标父目录下私有临时子目录中的排他临时文件。fsync 后复查原路径身份，再在同一目标文件系统排他发布，已有同名目标保持原内容。失败或取消清理本次临时文件与目录。当前执行成功结束后的自动归档由 Shell 输出 owner 负责。

[PDF adapter](pdf-command.ts)固定 pdf-lib 1.17.1 与 fontkit 1.1.0。create 使用 A4、固定字号、随包 Noto SansSC 的 wght=400 实例子集、真实字宽换行和显式页面，超限返回 layout_overflow。merge 和 edit 支持页面选择（拆分、删除、重排）、旋转、文字/PNG/JPEG 叠加及 text/checkbox/dropdown/option-list 表单；页面重组与表单填写不能同时指定。不支持任意正文原位编辑、自动重排、HTML 转 PDF 或复杂跨页表格。

固定变量字体不能直接按默认实例子集化：fontkit 1.1.0 会把原字体的奇数字形偏移截为短 loca，文字虽可提取，页图却缺字。显式实例化重编码可避开此偏移问题，但 encoder 仍会漏写末尾连续 flag 的计数，导致 B/D/P/X/x 等空白。[随包补丁](../../../../../patches/@pdf-lib%2Ffontkit@1.1.0.patch)仅给 ESM/UMD 两个入口补齐该计数，沿根 patchedDependencies 和 lockfile 可复现安装，保留原 MIT 许可；不修改字体 hash、不引入运行时或构建依赖。[编码回归](../../../test/isolated/tools/documents/fontkit-subset.test.ts)独立读取合成 glyf，核无重复、255边界及跨轮廓的 flags、点数和坐标。官方 fontkit 2.0.4 的同一 encoder 仍缺该收尾，换版本并不能单独修复；同版本静态 OTF 的 CFF 子集也会产生无效字体警告。全字体嵌入对照约 11.4MB，不作为交付方案，修后两页中文长文仍是小体积子集。

## 固定资产与执行边界

标准 Terminal 和 Native 构建生成 PDF.js 分页 worker、PDF helper、固定 Noto Sans SC 字体和字体许可。构建将内置 OfficeCLI 与 PDF 技能的只读资源放入同一制品库存。Service 核过 helper 摘要后才登记 helper 与 Bun 路径，运行时读取字体时再核其 SHA-256。 [构建](build-assets.ts) · [运行时校验](document-runtime.ts)

Desktop 使用各格式的独立原件预览。PDF 页面与文字层由已核验的分页 worker 读取。 [Desktop 预览与验证](../../../../../apps/desktop/README.md#办公输出文件) · [PDF 分页缓存](pdf.ts)

## 验证

内置 Skill、源文件边界和排他导出由隔离测试覆盖。构建资源后运行 PDF 脚本可检查中文字符实际栅格、合并、页面操作、叠加、表单及溢出拒绝。 [隔离测试](../../../test/isolated/tools/documents/office.test.ts) · [PDF 实际文件冒烟](../../../scripts/pdf-documents-smoke.ts)

2026-11-19 在 Windows Kite 桌面以 PowerShell 7.6.9 和 OpenAI `gpt-6-luna` 中等思考交付已有的五页 PPT。最终模型请求含交付回执，回复写入回执中的盘符路径。重开同一轮后分别从正文链接和文件卡显示五页，归档与保存文件的 SHA-256 相同。证据位于本机 `.cache/kite-native-path-live-d7d7b979/evidence/`。

2026-11-18 直接运行三个改编技能的 Quick Start 脚本和 JSON 操作数组。系统 PowerShell 5.1、PowerShell 7.6.9 与 Git Shell 的九组用例均通过，涵盖工作区落盘、中文内容回读、Excel 公式结果和单独调用复制成品。并行构建期间一次 XLSX 批处理报告内存不足，串行复验通过。记录在本机 `.cache/kite-format-skill-examples-62b9-2heTLV/proof.json`。

2026-11-16 在 Windows x64 与 Bun 1.4.4 下，单独构建办公资源后，用上游 Git 对象核对源码和构建产物中的 124 个文件，11 个 OfficeCLI 正文加载与对应文件一致。受控模型在真实 Service 中分别选择基础技能，经受管 PowerShell 调用 OfficeCLI 1.0.161，完成 DOCX、XLSX、PPTX 的生成、归档和回读，并修改和归档了 PPT 的工作副本。该验证覆盖本机技能选择和文件交付。 [技能与资源回归](../../../test/isolated/tools/documents/office.test.ts) · [Desktop 选择回归](../../../../../apps/desktop/test/isolated/native-office-toolbar-dom.test.tsx)

同日在 Windows x64 隔离 Kite Service 实测 `gpt-6-luna`。模型请求均使用 `reasoning.effort=high`，受管 PowerShell 通过临时 PATH 解析 OfficeCLI 1.0.161。PPT 原始轮加载 `office.pptx`，先后遇到跨 Shell 暂存路径失效、OfficeCLI 驻留启动和文件占用问题、PowerShell JSON 参数与脚本作用域错误。模型改用工作区副本和标准输入的 `officecli batch` 完成五页演示稿，验证后复制到最终 Shell 的输出目录。对照轮在测试 Shell 设置 `OFFICECLI_NO_AUTO_RESIDENT=1`，并在请求中明确工作副本与最终交付位置，单条 `add` 成功落盘，也完成五页交付。两份归档分别经新 Client 连接回读，核对 ZIP 内容并在隔离 Kite 原生预览中逐页切换。两轮的 OfficeCLI `screenshot` 均在受管 Shell 因 Chromium Crashpad 启动失败。日志、产物与预览图保存在本机 `.cache/officecli-luna-high-20261116/`。

Word 原始轮在输出目录和工作区的两次单条 `set` 均遇到文件占用，未交付修改稿。关闭自动驻留后直接对工作副本执行 `set`，归档修改稿并在原生预览读到目标文字。原件 SHA-256 一致，ZIP 差异只包括目标文字、对应段落的文本修订 ID 和 OfficeCLI 修改时间。Excel 原始轮在写入失败前归档了同名副本，最终回读摘要与未编辑的原件相同。关闭自动驻留且跳过显式 `open` 后，归档的 `Sheet1!B2` 为 12，`B4` 保留 `SUM(B2:B3)`。OfficeCLI 读取时算出 15，但归档 XML 缺少 `B4` 的缓存值。Kite 原生预览中的 ExcelJS 对该归档的 `x:` 工作簿标签解析失败，改为等价默认命名空间后仍在 `ap:` 扩展属性处失败。诊断副本规范化两处命名空间写法后可以打开，原缓存仍显示“计算结果不可用”。用 OfficeCLI 在另一个诊断副本重新写入同一条公式得到 `<v>15</v>`，规范化命名空间后 Kite 预览显示 15。六个完整会话的 94 次模型请求均返回 HTTP 200。 [Excel 原生预览](../../../../../apps/desktop/electron/xlsx-preview.tsx)

~~~sh
bun packages/agent/scripts/pdf-documents-smoke.ts
~~~
