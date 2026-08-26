# Service state 与目录锁

本页描述 `apps/kite-service` 对 `@kite-ai/kite-local-runtime/service` filesystem primitive 的使用。package拥有no-follow/atomic primitive；Service shell与manager拥有lifecycle decision。

调用方必须先提供显式、已验证且canonical的`KiteHomeIdentity`。Service不读取cwd、Workspace `.env` 或ambient `KITE_CODE_HOME`。V1固定布局为`<kite-home>/runtime-service/v1/{instance.json,access.token,control.token,instance.lock/,lifecycle.lock/}`。

POSIX目录必须owner UID且`0700`，文件必须owner UID、single-link regular file且`0600`。读取采用`lstat → O_NOFOLLOW open → fstat/inode recheck → bounded read`；发布采用同目录exclusive temp、fsync、atomic rename、directory fsync与strict readback。symlink、hardlink、type、owner、permission或parent identity drift均fail closed。Windows缺少current-user ACL/reparse verifier时明确`unsupported`。

child持有`instance.lock`，manager以`lifecycle.lock`串行ensure/status/stop/restart。锁不是健康证明；descriptor endpoint与initialize identity才是健康事实。alive/uncertain owner一律保留state且spawn=0；PID明确dead才可exact quarantine/cleanup，绝不kill。descriptor尚未发布但instance lock存在是starting/crash window，不能直接spawn。applied stop进入draining后仍由Service保留state；carrier/application全部关闭成功后才clear。

所有remove/quarantine携带刚读取的exact descriptor/token/lock identity；并发replacement改变inode/nonce时必须拒绝。验证：`bun test packages/kite-local-runtime/test/service-state.test.ts apps/kite-service/test/isolated/manager/native-adapters.test.ts apps/kite-service/test/isolated/native-infrastructure.test.ts`。
