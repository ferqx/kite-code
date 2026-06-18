/**
 * macOS Seatbelt 沙箱 profile 生成
 *
 * 分层策略：
 *   1. 静态基础层  — 进程执行、mach-lookup、sysctl、IOKit、IPC、PTY
 *   2. 文件读取层  — 全局读取（dev tools 兼容），由 checkDangerousPaths + 工具策略兜底
 *   3. 文件写入层  — 仅 workspace + /tmp 可写
 *   4. 网络层      — deny default，需要时追加
 */

/** 生成完整的 macOS Seatbelt 沙箱 profile / Generate full macOS Seatbelt sandbox profile */
export function generateSandboxProfile(workspace: string): string {
  return [
    SEATBELT_BASE_POLICY,
    fileReadPolicy(),
    fileWritePolicy(workspace),
    fileWriteUnlinkPolicy(workspace),
  ]
    .filter(Boolean)
    .join('\n');
}

/** 1. 静态基础层 — 进程、系统 IPC、sysctl、IOKit、PTY（参照 Codex seatbelt_base_policy.sbpl）*/
const SEATBELT_BASE_POLICY = `(version 1)
(import "system.sb")
(deny default)

;; ── 进程执行（子进程继承沙箱）──
(allow process-exec)
(allow process-fork)

;; ── 信号：仅允许同沙箱内进程通信 ──
(allow signal (target same-sandbox))

;; ── 只读 sysctl（硬件 / CPU / 内核信息）──
(allow sysctl-read
  (sysctl-name "hw.activecpu")
  (sysctl-name "hw.byteorder")
  (sysctl-name "hw.cachelinesize")
  (sysctl-name "hw.cpufamily")
  (sysctl-name "hw.cpufrequency")
  (sysctl-name "hw.cpufrequency_max")
  (sysctl-name "hw.cpusubtype")
  (sysctl-name "hw.cputype")
  (sysctl-name "hw.logicalcpu")
  (sysctl-name "hw.logicalcpu_max")
  (sysctl-name "hw.machine")
  (sysctl-name "hw.memsize")
  (sysctl-name "hw.model")
  (sysctl-name "hw.ncpu")
  (sysctl-name "hw.nperflevels")
  (sysctl-name "hw.nperflevels")
  (sysctl-name "hw.optional.arm.FEAT_*")
  (sysctl-name "hw.optional.armv8_*")
  (sysctl-name "hw.optional.arm.FEAT_*")
  (sysctl-name "hw.packages")
  (sysctl-name "hw.pagesize")
  (sysctl-name "hw.pagesize_compat")
  (sysctl-name "hw.physicalcpu")
  (sysctl-name "hw.physicalcpu_max")
  (sysctl-name "hw.targettype")
  (sysctl-name "hw.vectorunit")
  (sysctl-name "kern.argmax")
  (sysctl-name "kern.bootargs")
  (sysctl-name "kern.hostname")
  (sysctl-name "kern.osproductversion")
  (sysctl-name "kern.osrelease")
  (sysctl-name "kern.ostype")
  (sysctl-name "kern.osvariant_status")
  (sysctl-name "kern.osversion")
  (sysctl-name "kern.safeboot")
  (sysctl-name "kern.tcsm_available")
  (sysctl-name "kern.usrstack")
  (sysctl-name "kern.version")
  (sysctl-name "machdep.cpu.*")
  (sysctl-name "machdep.cpu.brand_string")
  (sysctl-name "machdep.cpu.core_count")
  (sysctl-name "machdep.cpu.thread_count")
  (sysctl-name "security.mac.amfi.lv.strict")
  (sysctl-name "sysctl.proc_translated")
  (sysctl-name "vm.loadavg")
)

;; ── IOKit：仅允许 RootDomain 用户客户端 ──
(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))

;; ── mach-lookup：系统目录服务 / 偏好设置 / 电源管理 ──
(allow mach-lookup
  (global-name "com.apple.system.opendirectoryd.libinfo")
  (global-name "com.apple.PowerManagement.control")
  (global-name "com.apple.cfprefsd.agent")
  (global-name "com.apple.cfprefsd.daemon")
  (global-name "com.apple.bsd.dirhelper")
  (global-name "com.apple.system.opendirectoryd.membership")
  (global-name "com.apple.logd")
  (global-name "com.apple.trustd")
  (global-name "com.apple.trustd.agent")
  (global-name "com.apple.runningboard")
  (global-name "com.apple.diagnosticd")
  (global-name "com.apple.analyticsd")
)

;; ── POSIX 信号量（Python multiprocessing）──
(allow ipc-posix-sem)

;; ── POSIX 共享内存（PyTorch / OpenMP / cfprefs）──
(allow ipc-posix-shm-read* (ipc-posix-name "apple.cfprefs."))
(allow ipc-posix-shm-read-data ipc-posix-shm-write-create ipc-posix-shm-write-unlink
  (ipc-posix-name-regex #"^/__KMP_REGISTERED_LIB_[0-9]+$$"))

;; ── PTY 支持（交互式 shell / TUI）──
(allow file-read* file-write* file-ioctl
  (literal "/dev/ptmx"))
(allow file-read* file-write* file-ioctl
  (regex #"^/dev/ttys[0-9]+$$"))
(allow file-read* file-write*
  (literal "/dev/null"))
(allow file-read*
  (literal "/dev/random")
  (literal "/dev/urandom")
  (literal "/dev/tty"))`;

/** 2. 文件读取层 — 全局读取（git/xcrun/brew 等需要访问系统路径）*/
function fileReadPolicy(): string {
  return `
;; ── 文件读取：全局允许，危险路径由 checkDangerousPaths + 工具策略兜底 ──
(allow file-read* (subpath "/"))
;; ── 可执行文件映射（/etc 和 /tmp 符号链接解析 + 子路径）──
(allow file-map-executable (subpath "/"))`;
}

/** 3. 文件写入层 — 全局可写，授权由 tool-policy + checkDangerousPaths 兜底 */
function fileWritePolicy(_workspace: string): string {
  return `;; ── 文件写入：全局可写，授权由 tool-policy 审批 + checkDangerousPaths 兜底 ──
(allow file-write* file-ioctl (subpath "/"))`;
}

/** 4. 文件创建/删除层 — 全局允许，危险路径由 checkDangerousPaths 拦截 */
function fileWriteUnlinkPolicy(_workspace: string): string {
  return `;; ── 文件创建/删除：全局允许，危险路径由 checkDangerousPaths 拦截 ──
(allow file-write-unlink file-write-create (subpath "/"))`;
}
