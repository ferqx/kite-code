# Harbor Kite adapter

这个独立实验把 Harbor 0.25.0 的 `BaseAgent` 接到真实 Kite CLI、默认 Service 和 Files 工具。产品源码基线固定为 `a83387c6b1623f5b46264b21bf080b91d4ed349e`；本目录和单独工作流不修改 Shell、Service 或客户端行为，也不随其他功能分支前进。

## 当前范围

- [Python adapter](kite_agent.py) 上传字面指令并调用已安装的 launcher。它不安装客户端、不写任务答案、不写 reward、不重试未知工作。
- [runtime](runtime.ts) 使用已有显式 development CLI，选择实际构建的 Service 字节。每次调用建立独立 HOME、development profile、空 Codex auth 目录和严格子进程环境，不读取宿主模型账户或继承模型密钥。
- CLI 的原始 Work 意图、终态和完整 answer 必须匹配。成功后冷重开同一 profile，以 GET 读取原 Command、Run、Execution，核对来源、身份和成功状态，再导出真实原生轨迹。
- 原生 bundle 存在 `kite-trajectory/`，不是 Harbor ATIF `trajectory.json`。保留原始 integrity 信息，包括 `facts: unknown` 和部分 evidence 可用性；读到字节不等于所有事实均已核实。
- deadline 覆盖 CLI 和冷导出。取消、超时、等待输入、失败和 unknown 保持区别。结束时清理所属 CLI 进程组并等待原进程及 paired exporter；有界清理失败记为 unknown。任意逃离所属进程组的任务后代仍依赖外层 Docker teardown，当前实验不声称完整沙箱安全资格。
- 首版只支持 Linux。MCP、Skills、恢复轨迹、Harbor 模型覆盖和额外凭据环境未实现时明确拒绝，不静默忽略。不申报 ATIF、安装发行、Windows、恢复、计费或真实模型成绩。

## 无密钥 smoke 制品

[Dockerfile](Dockerfile) 从固定 Bun 1.4.4、Rust 1.97.1 构建 native Files 和默认 Service；最终 Ubuntu 24.04 镜像只复制明确源码输入，不含本任务的 tests/verifier。CI 构建上下文来自 `git archive HEAD`，不含宿主 HOME、`.git` 或未跟踪文件。镜像来源版本和实际镜像摘要保留在日志中。

`/opt/kite-harbor/launch` 只在这个隔离 smoke 镜像中选择 [本地模型夹具](mock-launch.ts)。它在容器 loopback 上返回一次 `write_file` 工具调用和随后文本；真正的文件创建由 unchanged Kite Files 完成。export 前后请求计数必须不变，不能为了导出再次调用模型。

[任务](tasks/kite-file-smoke/task.toml) 不连外网，独立 verifier 也是无网络 Ubuntu 容器，只取得指定 `/app/answer.txt`。它核对精确内容，并拒绝可见的 agent runtime。正例运行真实 Kite，反例运行 nop；各一次、零重试，分别应得 1 和 0。正反例不证明模型泛化、复杂 Shell、办公文件收集或 Terminal 安装发行质量。

[工作流](../../.github/workflows/harbor-kite-adapter-smoke.yml) 只允许 `ci/harbor-kite-adapter-20261111` 分支，在 GitHub-hosted Ubuntu 上构建后顺序执行两种 agent。无密钥、无模型费用、无部署或镜像发布。它保存原始 Harbor/CLI/构建日志、输入校验和、原身份、原生轨迹、Docker 生命周期事件、实际 reward 和 [严格检查结果](check_smoke.py)，保留 7 天。检查要求独立容器、agent 销毁先于 verifier 启动、完整 trial、零异常、零重试和真实字节证据；进程退出 0 不单独算通过。

## 本地验证

先按仓库现有开发方式安装锁定依赖并构建 native Files 与 Service：

```sh
bun install --frozen-lockfile --ignore-scripts
bun run build:files-native
mkdir -p apps/service/dist
bun build apps/service/src/main.ts --target=bun --packages=external --outfile=apps/service/dist/main.js
python -m venv /tmp/kite-harbor-venv
/tmp/kite-harbor-venv/bin/python -m pip install harbor==0.25.0
/tmp/kite-harbor-venv/bin/python -m unittest discover -s integrations/harbor -p 'test_*.py' -v
bun test integrations/harbor/runtime.test.ts
bun x tsc --noEmit -p integrations/harbor/tsconfig.json
```

用新建的临时工作区、指令文件和输出目录运行 `bun integrations/harbor/mock-launch.ts --instruction-file /absolute/instruction.txt --workspace /absolute/workspace --output /absolute/logs --deadline-ms 120000`。不得把生产目录当作 smoke 工作区。输出已存在报告时拒绝覆盖。

本地已观察真实 CLI → 默认 Service → Files 写入、冷重开导出、超时和取消；本地不提供 Docker，因此当前 adapter 的 Docker/独立 verifier 结论必须以获准推送后实际 CI 结果为准。之前官方 Harbor oracle/nop 的 Docker 通过不能替代本 adapter 的 CI 验收。未提交本地测试的 `sourceDirty` 保持 true；CI 只用已提交 archive 并记录实际 commit。

## 接入真实 provider 前

[显式配置入口](launch.ts) 只读容器内特意配置的 `/opt/kite-harbor/config.json`，不会自动搜寻或复用个人账户。`/opt/kite-harbor/launch-real` 是单独入口，当前无配置且没有运行；smoke 不会切换到它。真实模型运行需要先确定 provider、具体模型、用途、请求/费用上限及安全的临时配置方式，并另行允许必要的网络目标。不要把密钥提交到 Git、放进 argv、日志或公开 artifact。现有无网络工作流不能直接当作付费模型评测流程。

Harbor agent timeout 设置为 240 秒，launcher 默认 deadline 为 120 秒；adapter 还需准备、上传、收尾和报告读取余量。扩大任务时同步核对三层时限，不靠重试掩盖 unknown。以后接入办公交付需要另行核对终态之后的 collection ready/failed；本次普通代码文件 smoke 不提前宣称该能力。
