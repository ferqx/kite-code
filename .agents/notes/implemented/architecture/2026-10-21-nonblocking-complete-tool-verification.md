# Agent Note: 工具完整校验的事件循环进展与原资源归属

Status: implemented

## Problem

主／子 Agent 使用同一普通 Loop，父任务的有限等待本身没有持有子任务所需的 Model 或 child 槽。真实执行仍会被共享 Service 的同步工作延迟：MCP 的完整 Ajv 编译和参数校验、Workflow 的来源编译与 schema 校验，以及 Files／Artifact 的全文读取和摘要会在一次调用中占住线程。仅将同步工作放进 async 函数或 async generator 不能让定时器、取消和其他会话取得进展。Artifact 注册的事务外全文验证还会独占同一个 Store Worker，原类别公平只在请求之间生效。

用户明确要求修复这些阻塞，并保持权限、完整校验与原始失败证据，尽量不使用真实模型。提高超时、缩小正文、跳过原文件复核或用历史缓存授予执行权均不满足该目标。

## Decision

MCP 的完整 schema 编译、输入和输出验证由准确 scope／catalogue 的 owned Worker 执行，沿原 schema、Ajv 配置、参数和结果，不修改原 definition/version。资产读取、摘要、共享启动、编译及本次验证共用原请求的绝对 deadline；取消或关闭先封门，再等实际 I/O 和原 Worker 收束。预 wire 无效保持零 RPC，post-wire 无法确认保持 unknown，不自动重发。仅准确 schema 的纯计算可复用，空闲回收不撤销业务授权，也不把缓存当许可。

Workflow 的正式 Service、执行、引用、Verifier、Compensator 与目录投影走异步完整读取和计算 Worker。Run binding 显式拥有 compiler session；单次目录读取另拥有自己的 session，库的独立调用自行关闭。仅复用 Worker，每次完整重读原文件／目录和当前 capability 事实，并对完整第二快照与前后事实确认。依赖 ID 的预发现只提取当前 YAML 中的声明，随后唯一正式编译仍执行全部 schema／契约验证；不为发现 ID 重复执行整份 Ajv。异常或取消确认原 Worker 退出，退出未知封闭 session 并保原资源，Service 先关闭 compiler 再关闭原 KnowledgeReadScope。

两种 Worker 只从固定 built JS 与 checksum 加载，不回退 TS、不从模型或配置选择执行资产。Service 将 Worker、checksum、preload 与观察资产加入普通／外部 Files 和恢复保护，Full 模式同样拒绝访问或覆盖。

Files 只读、Artifact 全文读取和发布回读按64KiB推进，累计8ms或64块后让出真实事件循环；原 FD／HANDLE、锚定目录及活动票据保留到完整 EOF 或实际关闭。Runtime 的二次语义摘要同样完整分片并传原取消信号。提前返回、取消或末尾错误不把前缀称为完整正文。Files 写入和编辑继续同步消费共享校验，不在原最终 CAS／发布临界区插入让出。

仅 Artifact 注册的事务外验证可沿私有 continuation 回到原 Store Worker 类别队首。状态绑定原 Operations／request ID／input，不接收 caller 的已验证标记；保持原 arrival、容量、类别 FIFO 和 close barrier，不并发执行 SQL。实际 EOF 和全文 hash 完成后才进入原短事务，事务内重新核 Store／scope；完整证明跨 BEGIN 等待时，写引用前仍核原路径与文件身份。最终 ACK 或失败收束原生成器，不重放已提交或未知的效果。

## Alternatives considered

1. 仅增加 await 或改成 async generator：原全文循环仍只交接微任务，不能使真实事件循环进展，未采用。
2. 放宽 timeout、减并发或缩小文件／schema／Artifact 额度：掩盖阻塞并改变已确认能力，未采用。
3. 跳过二次验证、缓存权限或凭历史 digest 复用来源：丢失新鲜度和原出处，未采用。Workflow 每次完整重读，MCP 缓存仅限准确 catalogue 的纯计算。
4. 每个 Workflow 检查都新建和退出 Worker：首版使原问答与目录回归超时，采用显式 Run 或请求 session 复用同一计算资源；不建立全局常驻 manager。
5. 将所有 Storage execute 改成可并发的 async 调用：会破坏事务、statement、timing 与请求 owner，未采用。只有尚未进入事务的完整验证按私有原请求 continuation 让出。
6. 取消后立即返回而不等真实 I/O 或 Worker 退出：会提前释放 owner 并把停止通知当实际结束，未采用；不能确认时保未知和原资源。

## Consequences

完整读取、纯计算和实际校验耗时仍然存在，但不再由上述整个循环连续占用 Service 或同 Store 的查询调度。单次慢磁盘系统调用、连续结果分配和完整 JSON 展开没有实时延迟保证；原控制类别 FIFO 不允许取消写跨过先前的登记。异步化不改变主／子 Loop，也不改变模型、权限、上下文或业务结果。

原[有界完整读取](2026-10-16-bounded-verified-file-reads.md)的内存与 chunk 所有权理由继续适用，内部私有 scratch 可以由合作分片消费者持有，不能逃逸到公开 chunk。原[正常 Loop 检查点](../bug-fix/2026-10-17-normal-loop-checkpoints.md)的写竞争、未知结果和不重放约束保持；本决定仅为事务前全文校验增加原请求 continuation。

当前完整合同与测试归 [MCP owner](../../../../packages/agent/src/mcp/README.md)、[Workflow owner](../../../../packages/agent/src/business/skill-workflow/README.md)、[Files owner](../../../../packages/agent/src/tools/files/README.md)、[Artifact owner](../../../../packages/agent/src/artifacts/README.md)及[跨包边界](../../../../docs/active/unified-agent-boundary.md)。本地固定 adapter、真实文件／SQLite／受控 loopback 与本机原生回归使用零真实 Provider；保留修前失败和中间回归。macOS 本地通过不授 Windows／Linux、持续 soak、独立安装或整体发行资格。
