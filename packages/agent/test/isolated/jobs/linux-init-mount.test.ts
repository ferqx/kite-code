import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const linuxTest = process.platform === 'linux' ? test : test.skip;
linuxTest(
  'mount namespace setup requires exact capabilities and preserves sealing and failure cleanup',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-linux-mount-unit-'));
    try {
      const source = join(root, 'probe.c');
      const binary = join(root, 'probe');
      writeFileSync(
        source,
        `#define _GNU_SOURCE
#include <stdarg.h>
#include <sys/syscall.h>
#include <sys/prctl.h>
#include <sys/statvfs.h>
#include <sys/socket.h>
#include <unistd.h>
#include <fcntl.h>
static int mode, step, inspections, mounts, stats, cleared, acknowledged, packets;
static ssize_t probe_sendmsg(int fd, const struct msghdr *msg, int flags);
static ssize_t probe_recvmsg(int fd, struct msghdr *msg, int flags);
static pid_t probe_getpid(void);
static pid_t probe_fork(void);
static int probe_pause(void);
static long probe_syscall(long number, ...);
static int probe_prctl(int option, ...);
static int probe_open(const char *path, int flags, ...);
static int probe_mount(const char *source, const char *target, const char *type, unsigned long flags, const void *data);
static int probe_statvfs(int fd, struct statvfs *out);
#define sendmsg probe_sendmsg
#define recvmsg probe_recvmsg
#define getpid probe_getpid
#define fork probe_fork
#define pause probe_pause
#define syscall probe_syscall
#define prctl probe_prctl
#define open probe_open
#define mount probe_mount
#define fstatvfs probe_statvfs
#define main original_main
#include ${JSON.stringify(resolve(import.meta.dir, '../../../native/linux-shell-init.c'))}
#undef main
#undef sendmsg
#undef recvmsg
#undef getpid
#undef fork
#undef pause
#undef syscall
#undef prctl
#undef open
#undef mount
#undef fstatvfs
static long probe_syscall(long number, ...) {
  va_list args; va_start(args, number);
  if (number == SYS_pidfd_open && mode >= 5 && step == 0) {
    va_end(args); return open("/dev/null", O_RDONLY | O_CLOEXEC);
  }
  if (number == SYS_capget || number == SYS_capset) {
    struct __user_cap_header_struct *header = va_arg(args, void *);
    struct __user_cap_data_struct *caps = va_arg(args, void *);
    if (header->version != _LINUX_CAPABILITY_VERSION_3 || header->pid) _exit(80);
    if (number == SYS_capget) {
      memset(caps, 0, sizeof(*caps) * 2);
      if (!cleared) {
        if (step++ != 0 || (mode >= 5 && !acknowledged)) _exit(81);
        caps[0].effective = caps[0].permitted = 1U << CAP_SYS_ADMIN;
        if (mode == 1) caps[0].effective |= 1U << CAP_DAC_OVERRIDE;
      } else if (step++ != 4) _exit(82);
    } else {
      if (step++ != 3) _exit(83);
      for (int i = 0; i < 2; i++)
        if (caps[i].effective || caps[i].permitted || caps[i].inheritable) _exit(84);
      cleared = 1;
    }
  } else if (number == SYS_unshare) {
    if (step++ != 1 || va_arg(args, int) != CLONE_NEWNS) _exit(85);
    if (mode == 2 || mode == 4 || mode >= 5) { va_end(args); errno = mode == 2 || mode == 5 ? EPERM : ENOSPC; return -1; }
  } else _exit(86);
  va_end(args); return 0;
}
static int probe_prctl(int option, ...) {
  va_list args; va_start(args, option);
  if (mode >= 5 && step == 0 && (option == PR_SET_NO_NEW_PRIVS || option == PR_SET_DUMPABLE)) {
    va_end(args); return 0;
  }
  if (option == PR_CAP_AMBIENT) {
    if (step++ != 2 || va_arg(args, int) != PR_CAP_AMBIENT_CLEAR_ALL) _exit(87);
  } else if (option == PR_SET_NO_NEW_PRIVS) {
    if (step++ != 5 || va_arg(args, int) != 1) _exit(88);
  } else _exit(89);
  va_end(args); return 0;
}
static int probe_open(const char *path, int flags, ...) {
  if (mode >= 5 && step == 0 && !strcmp(path, "/proc/self/ns/pid")) return open(path, flags);
  if (step != 2 || mode == 2 || mode == 4 || mode >= 5) _exit(90);
  if (!strcmp(path, "/proc/self/mountinfo")) inspections++;
  return open(path, flags);
}
static int probe_statvfs(int fd, struct statvfs *out) {
  (void)fd; memset(out, 0, sizeof(*out));
  out->f_flag = ST_RDONLY | ST_RELATIME;
  if (stats++) out->f_flag |= ST_NOEXEC | ST_NOSUID | ST_NODEV;
  return 0;
}
static int probe_mount(const char *source, const char *target, const char *type, unsigned long flags, const void *data) {
  if (step != 2 || source || !target || type || data || flags !=
      (MS_BIND | MS_REMOUNT | MS_RDONLY | MS_RELATIME | MS_NOEXEC | MS_NOSUID | MS_NODEV)) _exit(91);
  mounts++;
  if (mode == 3) { errno = EPERM; return -1; }
  return 0;
}
static ssize_t probe_sendmsg(int fd, const struct msghdr *msg, int flags) {
  (void)flags;
  if (mode < 5 || fd != CONTROL || packets++ || msg->msg_iovlen != 1 ||
      !strstr(msg->msg_iov[0].iov_base, "namespace")) _exit(98);
  return (ssize_t)msg->msg_iov[0].iov_len;
}
static ssize_t probe_recvmsg(int fd, struct msghdr *msg, int flags) {
  (void)flags;
  if (mode < 5 || fd != CONTROL || packets != 1 || acknowledged++) _exit(99);
  *(char *)msg->msg_iov[0].iov_base = 'P'; return 1;
}
static pid_t probe_getpid(void) { return mode >= 5 ? 1 : getpid(); }
static pid_t probe_fork(void) { _exit(100); }
static int probe_pause(void) {
  if (mode < 5 || step != 6 || !cleared || !acknowledged || packets != 1 || inspections || mounts || stats) _exit(101);
  _exit(0);
}
int main(int argc, char **argv) {
  if (argc != 3) return 92;
  mode = atoi(argv[1]);
  if (mode >= 5) {
    int pair[2];
    if (socketpair(AF_UNIX, SOCK_SEQPACKET, 0, pair) || dup2(pair[0], CONTROL) < 0) return 102;
    char *arguments[] = { argv[0], "mount_failure_nonce", "0", "/bin/sh", "printf FORBIDDEN", "workspace", argv[2], "--exec-assets", "--masked-roots", NULL };
    (void)original_main(9, arguments); return 103;
  }
  seal_paths[0] = argv[2]; seal_count = 1;
  int result = prepare_noexec();
  if (mode == 1) return result == -1 && step == 1 && !inspections && !mounts && !cleared ? 0 : 93;
  if (step != 6 || !cleared) return 94;
  if (mode == 2 || mode == 4) return result == -1 && !inspections && !mounts && !stats ? 0 : 95;
  if (mode == 3) return result == -1 && inspections == 1 && mounts == 1 && stats == 1 ? 0 : 96;
  return result == 0 && inspections == 2 && mounts == 1 && stats == 2 ? 0 : 97;
}
`,
      );
      const built = spawnSync(
        'cc',
        [
          '-std=c11',
          '-O2',
          '-Wall',
          '-Wextra',
          '-Werror',
          '-fstack-protector-strong',
          '-D_FORTIFY_SOURCE=2',
          '-fPIE',
          '-pie',
          '-Wl,-z,relro,-z,now',
          source,
          '-o',
          binary,
        ],
        { encoding: 'utf8', timeout: 10000 },
      );
      expect(built.error).toBeUndefined();
      expect(built.status, built.stderr).toBe(0);
      for (const mode of ['0', '1', '2', '3', '4', '5', '6']) {
        const ran = spawnSync(binary, [mode, root], { encoding: 'utf8', timeout: 2000 });
        expect(ran.error).toBeUndefined();
        expect(ran.status, `${mode}: ${ran.stderr}`).toBe(0);
        expect(ran.stdout).toBe('');
        expect(ran.stderr).toBe(Number(mode) >= 5 ? 'kite_linux_shell_close_unknown\n' : '');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
