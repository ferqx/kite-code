# 内置办公运行时

[office-documents Skill](../../skills/office.ts)是[内置 registry](../../skills/registry.ts)的一项不可变知识源；声明资源与正文一起绑定版本 hash。没有名为 officecli 的模型 capability，也没有新增交付工具或更改 Shell 模型参数。Service 遍历 registry；全局目录可发现办公技能，是否能执行仍由当前真实 Shell 权限决定。

## 制作与交付

[helper](kite-documents.ts)由已有 Bun 执行：`"$KITE_DOCUMENTS_BUN" --no-install "$KITE_DOCUMENTS_HELPER" office --format docx --input ops.json --out "$KITE_OUTPUT_DIR/report.docx"`。修改使用 `--source working.docx`；`--input -`接 JSON stdin。操作直接采用上游 OfficeCLI batch 数组，不另造编辑 DSL。

Skill 默认要求 POSIX Shell 兼容语法，额外比对先在工作区副本完成，不用忽略错误来制造成功。helper 成功或输出路径不等于交付：整个 producer Shell 成功后才开始收集；非零退出不收集该次残留，结果未知先核原执行状态。恢复从已核验且仍可用的工作区源开始，在新 Shell 当前 KITE_OUTPUT_DIR 导出并核终态，不引用旧临时目录，不凭对话重建无法读取的原件；收集未确认时明确保留未完成步骤。此为技能指导，不新增工具、不修改权限或放宽收集失败检测。

[Office adapter](office-command.ts)创建私有工作稿，一次 batch 后核每项 success；退出2仅在明确的 LaTeX warning 且各项成功时进入后续 validate。结构错误或失败项不交付。XLSX 另读 content issues，明确公式求值或缺失工作表错误阻断；未计算、旧缓存及普通可选检查失败保留计算未完全验证警告。进程退出／清理未知、执行范围或输出身份变化、路径安全失败必须透传并停止导出，不能降级为计算警告。没有 issues 不证明 Excel 全功能重算。

[稳定导出](document-export.ts)用打开的 regular-file 身份、固定字节上限、读前后 size/mtime/ctime 核验和目标父目录下私有临时子目录中的排他临时文件；fsync 完成后排他 link 到最终名称，不覆盖同名输出。避免跨 Shell 临时目录与工作区进行硬链接；失败或取消清理本次临时文件与目录，不删除目标。工作区中的新路径可作中间副本，最终交付使用 KITE_OUTPUT_DIR 中的新路径。源文件始终不修改。当前执行成功结束后的自动归档由 Shell 输出 owner 负责；helper 本身不保存 Artifact，不重试生成。

[PDF adapter](pdf-command.ts)固定 pdf-lib 1.17.1 与 fontkit 1.1.0。create 使用 A4、固定字号、随包 Noto SansSC 的 wght=400 实例子集、真实字宽换行和显式页面，超限返回 layout_overflow。merge 和 edit 支持页面选择（拆分、删除、重排）、旋转、文字/PNG/JPEG 叠加及 text/checkbox/dropdown/option-list 表单；页面重组与表单填写不能同时指定。不支持任意正文原位编辑、自动重排、HTML 转 PDF 或复杂跨页表格。

固定变量字体不能直接按默认实例子集化：fontkit 1.1.0 会把原字体的奇数字形偏移截为短 loca，文字虽可提取，页图却缺字。显式实例化重编码可避开此偏移问题，但 encoder 仍会漏写末尾连续 flag 的计数，导致 B/D/P/X/x 等空白。[随包补丁](../../../../../patches/@pdf-lib%2Ffontkit@1.1.0.patch)仅给 ESM/UMD 两个入口补齐该计数，沿根 patchedDependencies 和 lockfile 可复现安装，保留原 MIT 许可；不修改字体 hash、不引入运行时或构建依赖。[编码回归](../../../test/isolated/tools/documents/fontkit-subset.test.ts)独立读取合成 glyf，核无重复、255边界及跨轮廓的 flags、点数和坐标。官方 fontkit 2.0.4 的同一 encoder 仍缺该收尾，换版本并不能单独修复；同版本静态 OTF 的 CFF 子集也会产生无效字体警告。全字体嵌入对照约 11.4MB，不作为交付方案，修后两页中文长文仍是小体积子集。

## 固定资产与执行边界

[构建准备](prepare-office-assets.ts)仅在构建时获取[固定锁](office-assets-lock.ts)中的官方平台二进制和中文字体，核 SHA-256 后复制到 `tools/documents/office-assets`。OfficeCLI 固定1.0.160、commit c56512c8c7b76fe284f09940e4cd492470099d3e；它是 self-contained .NET 单文件，用户无须另装 .NET。字体为 noto-cjk Sans2.004 的 NotoSansSC-VF.ttf，OFL全文随包；OfficeCLI Apache许可、NOTICE和上游第三方许可全文、KaTeX MIT许可及固定0.16.11的 JS/CSS/全部字体同入资产 manifest。helper JS由现有Bun执行，不打第二份Bun。原 documents build-assets入口随 Agent构建纳入Terminal库存和Native复制闭包。

[运行时解析](office-runtime.ts)不下载、安装或升级。每次固定子进程覆盖 `OFFICECLI_NO_AUTO_RESIDENT/ SKIP_UPDATE/ NO_AUTO_INSTALL=1`，直接传 argv，避免Windows节点路径被Git Bash改写。Service须注入helper路径/现有Bun路径，并把确切二进制纳入平台执行身份，不授予安装目录写权限、不解除temp noexec。Windows ARM64即使上游有资产也拒绝，本次不据资产存在宣称平台资格。

`runOfficeCLI`仅供已受管Shell中的helper直接子进程；输出上限2MiB、最长120秒、取消后等待实际close，未知close保留工作目录并报exit_unconfirmed。它不是跨平台进程树所有权证明。宿主预览必须注入已有owner的runner，不以普通spawn替代宿主监督。

Windows helper 的直接子调用使用[专用文件句柄叶](windows-process.ts)：Bun 1.4.4 在现行受限 token 下创建 stdio pipe 会报 EPERM，沿[已有 Git 兼容决定](../../../../../.agents/notes/implemented/bug-fix/2026-11-06-windows-worktree-git-stdio.md)在本 Job 私有 TEMP 创建排他的 stdin/stdout/stderr 普通文件 FD；不借用外层机器回执的输出、不改变 token、ACL、Job、审核或协议版本，其他平台保持原 pipe 路径。每流独立限制2MiB，增量读取并核最终 EOF 与文件／目录身份；取消或超时只在实际 close 后清理，5秒仍未确认时以外层 `office_process_exit_unconfirmed` 保留 stdio 和工作稿。清理仅关闭自己的 FD 并按原身份定点移除，清理未确认不得返回成功。普通文件 FD 不提供任意后代树证明，仍由外层 Shell Job 监督；Windows 的 `network:none` 沿原环境提示范围，不据此宣称 OS 网络隔离。

2026-11-12 Windows x64／Bun1.4.4 的真实局部 Word 请求在旧 pipe 路径出现 EPERM，OfficeCLI 未启动、原件未变、无新产物；同一受管 scope 内 Bash 直接 OfficeCLI 成功，Bun pipe 启动 OfficeCLI 或 Node 均失败。全 FD 对照及新生产 Windows 叶的 `--version` 均返回1.0.160，原 Job 全树停止、关闭和清理确认，未修改权限。以上仅证明子进程兼容路径，不是文档修改或产物重开验收；完整 Office 流程状态与真实交互证据归[Desktop owner](../../../../../apps/desktop/README.md#办公输出文件)。[生命周期回归](../../../test/isolated/tools/documents/windows-process.test.ts)在独立进程中对确切生产源码仅替换 spawn 进行受控事件验证，覆盖正常／非零、同步启动失败、异步错误、双流超限、取消／超时、close 未知保留、身份替换与清理失败；它不冒充真实 OS 故障注入，生产无测试注入入口。

## 离线预览

[固定recipe](office-preview.ts)只处理此固定OfficeCLI版本的输出，保留导航/页签脚本，替换KaTeX初始及fallback URL，外部字体URL改为本地声明资源（不强制应用），移除Three importmap/module并明确提示复杂3D/动画不支持。离线说明使用固定定位、默认收起的details，不参与Office正文的flex布局；真实PPTX曾因普通body子div提示挤窄页面，现已修复并通过580px隔离预览的页宽、键盘翻页、全屏／退出与DOCX／XLSX回归。它不是通用HTML安全过滤器；调用者必须用独立、无preload/Native bridge的隔离view，并由manifest查资源、拒绝外网及导航，不放宽主renderer CSP。

DOCX recipe 仅在固定渲染器的精确函数锚点匹配时补布局就绪描述：`data-kite-word-pagination-state` 为 pending／settled／unavailable，generation 在字体、图片、resize 或相关页树变化时递增。等待资源与原分页递归完成，再执行最终布局及双 rAF；最终验证期间变更、外层整页插入／移除也撤销旧代次，自己的同步布局变更不形成循环。15秒、256轮、500页与32MiB预算超限或未知模板不提供页级能力，不删除正文。该 marker 仍是不可信页面描述，不是源文件页码或授权；宿主须固定原文本块映射并在投递前复核。这里没有协议／资产版本升级、Microsoft Word COM 或通用浏览器重构。旧无 marker 的缓存页不提供整页请求；普通关闭不清全部缓存，owner dispose 才释放。

[分页回归](../../../test/isolated/tools/documents/word-pagination.test.ts)覆盖固定锚点、资源与最终双 rAF 竞态、页树变化、失效与预算。2026-11-12 Windows 真实受管转换及正常沙箱隐藏 Electron 另验证实际长文7页、晚图片后8页，字体／resize后重新 settled、准确原请求失效和静置稳定；三页显式分页样本第2页保持两个准确源块。预览页是 HTML 排版结果，不承诺与原生 Word 页码相同；可见请求与完整编辑交付证据归 Desktop owner。

宿主按需传已验证快照路径和不已存在的输出目录；runner负责超时、取消和进程清理。manifest逐文件给相对路径、绝对受控路径、MIME、size与hash。缓存身份使用sourceHash、officeRendererVersion、officePreviewRecipeVersion；转换失败不影响原文件保存、下载或继续修改。PDF保留[现有PDF.js分页worker](pdf.ts)，该Bun执行设施不能直接当Electron Node worker使用。

## 验证与限制

[隔离测试](../../../test/isolated/tools/documents/office.test.ts)核registry绑定、batch退出码、Excel严重/不完整问题、固定离线改写、源不变与失败不发布。[真实fixture脚本](../../../scripts/office-documents-smoke.ts)在构建资产后运行：`bun packages/agent/scripts/office-documents-smoke.ts`。2026-11-11 Linux x64/Bun1.4.4，三种Office格式的制作/validate/HTML，以及PDF中文、合并、页面操作、叠加、表单和overflow拒绝通过。后续真实页图发现早期中文提取检查遗漏空白字形，现已按上述固定实例与补丁修正；fixture逐字栅格检查104个中文、标点、英文大小写和数字，分别覆盖create、重组页面叠加及可见表单，并限制子集输出体积。独立Poppler逐页检查中文换行和显式分页，FontTools解码实际嵌入字形，不以系统字体回退或可提取文字作为成功依据。普通直接进程smoke不等于受管noexec、macOS签名allow-jit、Windows Job清理或完整安装发布资格，这些仍须各平台owner实际核验。随后Linux真实云桌面Electron44.3.0正常沙箱沿独立Main预览核DOCX中文滚动、XLSX双表往返、PPTX页宽／键盘／全屏与退出；另以含分式、根号、求和的DOCX／PPTX实际观察离线KaTeX，外网、localhost、file、导航、新窗口和Native bridge隔离保持。单样本preview.open首次／同hash重开分别1482／166ms、1590／356ms，不含人工驻留，不外推大文件整体表现。PPTX提示挤版修复和首次合成花屏／冷启恢复的准确证据边界归[Desktop owner](../../../../../apps/desktop/README.md#办公输出文件)，不将单个隔离预览当完整Service交付链路。

预览字体不再给 body 或所有后代强制套用随包字体；font.css 仅声明本地 KiteDocument @font-face，保留作者 CSS／inline 字体及系统回退。缺少作者字体时仍可能发生替代与排版差异，不下载外部字体，也不承诺各平台原字体存在。内部渲染缓存身份改为 offline-author-fonts，沿原 sourceHash／renderer／recipe 键隔离旧 offline-1 强制字体产物；不改变工具或公开协议版本。Word 字体 loading／loadingdone／loadingerror 继续使布局代次失效并重新分页，标记不授予文件权限。

技能的能力发现使用固定二进制 `--help` 与已发现子命令的 `--help`，不猜 mode/属性，也不把上游参数交给 helper。修改验收分别核原件字节完整、另存目标变更和相关内容语义不变；ZIP 包装或 XML 序列化差异本身不判内容回归，结构合法不代替任务验收。手动固定资产回归：`bun test packages/agent/test/integration/office-skill-contract.test.ts`；要求本地已准备且校验通过的资产，不安装或下载，覆盖真实帮助、helper 修改、原件保护及独立读取的目标／邻格／公式和归档元数据差异，不代表真实模型或任意格式保真。

编辑产生的元数据仅按已解释的准确 part／节点／命名空间／字段建立窄例外，并核字段身份、类型和新值合法性；不忽略整个 metadata，邻段、正文、样式、表格和关系仍严格核验。上述手动固定资产回归另用本机 Python 3 标准库独立读取真实两段 DOCX：只允许目标段 w14:textId 与准确 OfficeCLI.LastModified 时间值变化，核原件 hash，并注入13种邻段、内容、样式、表格、关系及字段身份／类型／非法值变化确认拒绝。测试专用 oracle 不进入产品、不提供通用 Office 比较引擎；缺本机 Python 或固定资产按失败报告，不下载替代。

原件 hash 指导使用已有 KITE_DOCUMENTS_BUN 的 node:crypto，不假设 macOS 存在 sha256sum。包集合先枚举差异：首次编辑新增的已知编辑器属性 part 也须逐字段解释，并核唯一配套 ContentType 和 relationship；未知新增／删除仍拒绝，不降低正文、样式和关系检查。固定资产回归补无 custom 属性的外来 DOCX 副本，真实 helper 编辑后精确核 OfficeCLI.Version／LastModified、新增 part 及关联，并注入未知 part、属性、关系、类型、正文和样式变化确认拒绝。失败 Shell 临时输出不能跨调用恢复的现有指导保持，不以本回归声称模型总能遵循。
