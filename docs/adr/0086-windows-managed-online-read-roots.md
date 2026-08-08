# ADR-0086：Windows Online 身份在 setup 阶段配置持久只读根

状态：accepted

日期：2026-08-06

相关：ADR-0084、ADR-0085

## 背景

ADR-0085 的 Online primary token 修复了 Schannel，但专用账户默认不能穿越原用户 profile 下的
Workspace、临时 runtime 或 PATH 工具目录。若在每次 invocation 中给 `USERPROFILE` 祖先临时增加 ACE，
Windows 可能触发大范围继承传播；命令会长时间占用 ACL lease，crash recovery 也会重复该成本。

Codex 的 Windows sandbox 把 sandbox identity 的 read roots 放在 elevated setup 中配置，并排除常见凭据
目录。Kite 应采用相同的 control-plane/data-plane 分离，而不是让普通联网命令改写 profile 祖先 DACL。

## 决策

1. managed-network setup payload V2 包含发起用户 `USERPROFILE` 下已存在、非 reparse-point 的顶层目录。
   `.ssh`、`.gnupg`、`.aws`、`.azure`、`.kube`、`.docker`、`.config`、`.npm`、`.pki` 等敏感目录不得
   加入 read roots。
2. elevated helper 创建并验证 `KiteSandboxOnline` 后，向这些 read roots 持久授予 read/execute；setup
   state/marker 升级为 V3，旧安装必须重新完成一次显式 setup，marker 仍在全部设置成功后最后提交。
3. setup 使用 machine-wide mutex 串行化账户密码轮换和 ACL 配置，避免并发 UAC setup 互相覆盖凭据。
4. 普通 approved invocation 不修改 `USERPROFILE` 祖先 ACL。per-invocation lease 只处理 Workspace、runtime、
   固定 Shell/runner binary 的所需权限与当前 protected paths deny，并在 Job 清空后撤销临时 ACE。
5. 持久 read roots 只解决工具与 Workspace 的可读/可穿越性，不授予写权限、不改变 Full qualification，
   也不取代 protected-path deny 或网络审批。

## 后果

- 新安装或换机只需一次明确的 setup/UAC，之后 curl、Node、npm 等 PATH 工具可在 Online 登录会话中读取
  所需 runtime；普通命令不再因 profile ACL 传播而阻塞。
- setup 可能因大型 profile 的 ACL 继承配置耗时，但该成本不进入每条 Shell invocation。
- 被排除的凭据目录保持不可由 Online identity 读取；如将工具仅安装在这些目录，用户必须把工具放到已授权
  的非敏感 read root，不能由命令期自动扩大权限。

## 对既有决策的影响

本 ADR 补充 ADR-0085 的 ACL 生命周期：其临时 write lease 保留，但 `USERPROFILE` read/traverse 不属于 lease，
而属于 ADR-0084 的显式 setup。ADR-0085 中把 runner state 列入临时 Online grant 的表述不再适用。
