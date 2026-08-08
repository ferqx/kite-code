# ADR-0073：Windows Shell 使用私有 Workspace staging 与拒绝式回写

状态：accepted
日期：2026-08-05
决策者：`github:@ferqx`（Security + Platform，single-maintainer）
关联：ADR-0054、ADR-0061、ADR-0072

## 背景

ADR-0072 的 Classic AppContainer + ACL 方案若直接把真实 Workspace 授权给 invocation SID，能够用
deny ACE 保护既有固定路径，却无法用 Windows DACL 表达“允许任意普通新文件、拒绝名称匹配
`.env.*` 的新文件”。因此 Shell 变量、间接展开或 descendant 可以在执行期间首次创建动态敏感文件名。
命令字符串扫描不是 OS 级防护，不能解决该缺口。

## 决策

1. adapter 为每个 Windows Shell invocation 创建独立的 private Workspace staging；AppContainer 只获得
   staging、runtime 与固定 runtime bundle 的 ACE，真实 Workspace 不获得 invocation ACE。
2. 初始 staging 只复制普通文件和目录；protected root path 与 source reparse point 不复制。这样 child
   即使计算出动态 protected 名称，也只能写入 private staging。
3. 仅在命令 exit 0、未超时/取消且 native Job/ACL cleanup 已确认后允许回写。回写先完整扫描 staging，
   并在任何真实 Workspace 写入前拒绝 reparse point、unsupported object、protected path、动态
   `.env.*`、以及与初始快照不一致的真实 Workspace。
4. 预检通过后仅回写普通文件/目录的创建、修改和删除；read-only invocation 从不回写。预检或回写失败
   必须将 invocation 变为 fail closed。

## 后果

- 动态受保护路径不再依赖 DACL 文件名通配符或命令字符串识别，真实 Workspace 在 child 运行期间保持
  不可写；
- 普通 Shell 文件改动仍可在成功执行后保留；并发宿主编辑会以 reconciliation conflict 拒绝而非覆盖；
- V1 不保留 Workspace source symlink/junction。依赖 reparse point 的项目在 staging 内缺少该入口，
  应 fail closed，直到存在可证明不会重开真实 Workspace 的专门链接虚拟化方案；
- staging 复制/扫描增加 I/O 成本，但这是换取动态 protected-path 强制隔离的必要代价。

## 备选方案

- 真实 Workspace 父目录的通配 deny ACE：拒绝；Windows DACL 不支持按新文件名通配 deny。
- 仅命令字符串扫描：拒绝；变量、shell expansion 与 native child 可绕过。
- 执行后删除敏感文件：拒绝；文件已在真实 Workspace 存在过，不能证明没有被读取、同步或触发。
- 文件系统 minifilter/ProjFS：延后；需要独立安装、驱动或复杂虚拟化，不符合当前 per-invocation 无管理
  权限 V1 约束。
