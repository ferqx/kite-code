# Agent Note: 显式 daemon 的私有发现与 HTTP 业务边界

Status: implemented

## Problem

[服务手册](../../../../docs/handbook/server/lifecycle.md)保留显式 `--server` 的本地 socket/pipe 地址、固定工作区、兼容实例复用和准确停止；[V1.3](../../../../docs/plans/unified-agent-refactor-v1.md) D09、§27 又要求业务唯一 HTTP JSON/SSE，私有 bootstrap 只交换启动、认证和生命周期信息。现有新配对 Service 有 HTTP 生命周期，但没有 daemon 发现和所属 endpoint，不能直接把配对子进程脱离父管道后称为 daemon。

## Decision

在私有 Service/launcher 边界实现有限 native bootstrap，不进入公共 Client/UI。socket只处理一次闭合 bootstrap 请求，返回固定原 profile、instance、build、PID/准确启动身份、canonical Workspace、HTTP endpoint/token和Web origin。Token不写reservation、CLI JSON或日志；业务API和busy状态随后由原HTTP Service校验，native通道不复制业务RPC或第二个shutdown协议。

平台leaf先于Store取得准确endpoint reservation，不知道Runtime、模型或restart。普通status/absent只读，不创建profile或endpoint目录；普通start不清理未知占用。显式dead清理必须同时证明原PID/start已死、完整reservation和socket inode未漂移；不以路径存在或PID单独判断。默认Unix地址由canonical profileAccessKey映射到固定系统temp下当前uid私有短目录，严格验证现存owner、权限、链接和共享parent sticky条件，显式超长路径拒绝而不改投。

POSIX listener使用预先bind的原文件描述符，再交给`net.listen({fd})`。实际macOS Node22.21.1/Bun1.4.2探针证明：按pathname listen时，原socket被rename并放入替换文件后，`server.close()`会自动删除替换文件；预bind fd方式保留替换文件，并由net关闭所属fd。因此路径清理只能由原owner在核对准确inode后执行，不能把手动unlink前的检查当成runtime自动清理的保证。

macOS进程身份使用本机SDK已核实的libproc `proc_pidinfo(PROC_PIDTBSDINFO)`，核真实PID以及秒/微秒启动时间；不回退秒精度`ps lstart`。Linux使用boot ID和proc start ticks。Windows x64现有独立源码leaf，以当前Token SID和OS KnownFolder确定私有记录目录，原protected DACL／非继承HANDLE与REJECT_REMOTE pipe拒绝外来访问；不复用旧`server.listen(pipeName)`。进程身份为原creation FILETIME，明确stop持同一process HANDLE；cold查询只有完整kernel观察可证明dead，失败保uncertain。实际Windows ABI／ACL／pipe／前门尚未运行，源码接入不能放行平台资格。

2026-10-10补充：Windows reservation保完整父链和原record HANDLE／FileID；只私有直接父目录需要删除权限，公共祖先只读pin。publish前原FIRST pipe已取得且有限overlapped listener已接入；记录无token。客户端核原pipe server PID和held process birth，再走同一公共HTTP Client；回复写完后仍在原deadline内等客户端关闭，避免[DisconnectNamedPipe丢弃未读数据](https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-disconnectnamedpipe)。所有原I/O／event／pipe／record关闭必须确认；未知强持原owner与资源，daemon沿有限marker和ref计时器保活，不能被身份／漂移错误改写或释放候选使用权。严格自有pipe词汇及平台验收归[Daemon owner](../../../../apps/service/src/daemon/README.md)。

配对与daemon共用一次Service装配，保持唯一Runtime/Loop；父EOF只用于配对策略。daemon固定原Web资产，并在最终资源关闭阶段封Browser入口、撤销Cookie和排空原请求，随后关闭Store、Native HTTP和所属endpoint。关闭失败保留真实诊断与资源。CLI restart先验证目标制品/资产和可安全检查的Store格式，再向原实例发一次if_idle/cancel关闭；普通start允许坏Store保留安全诊断服务。确认原PID/start退出后才启动新目标，超时不强杀、不偷偷启动替代。

2026-10-06补充：真实Job原核实的shared收尾曾在一次原shutdown后命中daemon_identity_uncertain。身份函数读不到kernel start且PID仍存在时只能保uncertain；该次libproc读取失败的具体原因未知，不能推断为dead。关闭编排现沿原PID/start在既有15秒检查窗口继续只读观察，取得新的真实dead证明才成功；持续uncertain到检查点仍失败，drain_failed仍保资源。最初发现与dead endpoint清理的严格规则保持，不重发shutdown、不发送OS信号、不换目标或启动替代。末次一秒HTTP观察和调度可越过检查点，实际持续故障15.84秒，不宣称硬实时15秒资格。

显式共享CLI/TUI经同一私有bootstrap接入已有daemon，预期profile和必需capabilities在发现前确定，原instance/build由私有通道固定后与HTTP准入核对。省略workspace沿用daemon的canonical目录；显式路径不同则拒绝，已存在Session也须核其Workspace。共享宿主没有对子进程的所有权，关闭只调用Client.disposeNetwork；TUI独立UI lease与草稿保存继续由原宿主持有。网络恢复仍核原实例，不能以发现新daemon替代原目标或重放旧写入。

## Alternatives considered

- 把`--server`改成HTTP URL：改变已有用户地址语义，故保留私有发现端口。
- 复用旧socket业务carrier：与唯一HTTP业务边界冲突，因此只迁移独立安全leaf和所需事实。
- 公共Client引入fs/net/FFI：破坏browser-safe依赖边界，故由私有宿主做发现，再使用已有公共HTTP Client。
- pathname listener再手动检查inode：实际runtime自动unlink仍会删除替换文件，因此使用预bind fd所有权。
- shutdown后首次uncertain立即失败：真实收尾命中该状态，仍可能随后取得原进程真实dead证明；继续已有有界只读观察，不降低成功证据。
- 把uncertain直接当dead或从shutdown受理推定退出：会给替代启动/endpoint清理错误权利；持续不明继续失败，真实kernel身份与资源关闭分别证明。

- daemon复用配对父EOF关闭：启动客户端退出会错误停止共享服务，因此存活策略独立，装配共享。

## Consequences

该决定已用于正式Terminal和开发daemon的平台leaf、共用装配、CLI编排及资产接入。macOS实际进程已验证socket竞争/漂移、默认与显式endpoint、父EOF差异、Web排空、原实例busy/cancel及预检失败保留旧服务。装配与清理双失败没有HTTP handle时，通过有限marker强持原资源并用ref计时器保持进程存活，daemon reservation不释放；不能把未resolved Promise本身当作进程保活。错误输出只保code/phase，内部cause不序列化。独立编译子进程已验证断开父管道仍alive、原Store使用锁busy及第二启动被原reservation拒绝。

Windows正式父launcher在spawn前验证完整candidate并持自身SH／原文件pins，固定Bun关闭ambient env/install/bunfig/tsconfig；实际Daemon在endpoint／Store／preflight之前取得自己的candidate使用权，Service装配仍保独立准入。成功准确handoff或原子进程真实退出后父权才释放；初始artifact获取关闭未知也走保活。安装qualification以原总期限要求B daemon→回退A仍复用B→A公共共享任务→busy拒绝／明确cancel→原HANDLE dead／新A完整冷结果→正常stop／双EX；B标签变化不冒称跨代码升级。实际Windows资格与Native／PTY／Shell／MCP范围仍独立待验。

这些macOS进程证据与后来正式Terminal实际完整安装证据分别保持原范围，不代表Linux/Windows或完整发行资格；默认与显式socket选择必须完整保留，不能将默认地址作为显式字符串重算而改变record位置。启动前的独立只读Store预检不创建Runtime，失败保旧进程；未知关闭只观察原实例，不重新POST。总体状态与完整缺口见[实施进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)。

## Verification and limits

实际隔离进程证明：缺席status零路径创建；endpoint竞争只有一个owner；记录/socket漂移保留；死进程只凭完整准确证明清理；配对EOF关闭而daemon客户端退出不关闭；busy保留、明确cancel等待原进程退出；坏目标资产或Store格式在停止旧实例前拒绝；Web固定原资产、只读权限和真实排空；源码树外完整manifest无旧Runtime回退。未知关闭不重发由公共Lifecycle Client既有用例证明，CLI不强杀或重复POST由本轮实现核对；尚无全部CLI超时/未知handoff故障窗口测试。当前macOS结果与Linux/Windows未验证范围分别记录。

2026-10-06真实原Job消费者保原paired/shared核实、旧unknown结果和一次外部效果，受控一次/持续身份观察故障分别成功/失败；两次独立明确关闭各POST=1。1例43断言及原10文件daemon-host shard33例297断言通过，fixture另用未注入的真实kernel身份等待所属进程结束后清理。该故障注入不证明真实kernel窄窗因果或其他平台；自然红、受控红、冻结SHA与准确限度归总体进度。

## Remaining constraints

文件描述符转交必须只有一个关闭owner，避免重复关闭复用后的fd；native帧与连接均需有限预算。平台身份观察失败只能保留uncertain，不能以无结果推断死亡。Windows named pipe的DACL与远程连接边界尚无实际证据，不能用POSIX结果放行。格式预检与随后启动之间仍可发生合法文件变化，启动必须再次执行正常准入，预检不授予绕过权。

公布 reservation 的 socket identity 前，原 fd 必须已经通过 libc listen 进入内核监听状态。实际完整回归曾捕获 bind 后先公布身份、再由 net 异步监听的短窗口，原实例立即连接返回 unavailable。现先监听再公布，net 继续只接管原 fd，inode 清理规则保持；原输出管道立即关闭/原实例发现测试连续八次验证同一边界，不增加客户端重试或更改目标。
