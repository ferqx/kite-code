/*
 * Trusted PID-namespace init; not a general-purpose command launcher.
 * Invocation: nonce graceMs absoluteShell command workspace|full|confined tempPath [confinedNoExecPaths...]
 * --exec-assets trustedExecutableFiles... --masked-roots protectedPaths...; fd 3
 * is an inherited private AF_UNIX/SOCK_SEQPACKET endpoint. bubblewrap must use
 * --unshare-user --unshare-pid --as-pid-1. --die-with-parent may be a
 * crash-only fallback; its SIGKILL never proves normal ended. The as-pid-1
 * exec path preserves otherwise unconsumed inherited descriptors.
 *
 * Each packet has exact JSON keys and SCM_CREDENTIALS. namespace additionally
 * carries [original init pidfd, original pid namespace fd] via SCM_RIGHTS;
 * root carries [original root pidfd]. P accepts namespace, G accepts root,
 * C cancels. No packet claims a host PID. The receiver must independently bind
 * the received kernel objects/credentials and validate the complete protocol.
 *
 * Terminal is provisional until the outer original bubblewrap child has
 * actually closed with code 0, both pidfds are dead, and every pipe is EOF.
 * parent_eof/control_error are never normal completion. Any unknown native
 * close/wait/I/O retains this process rather than inventing an ended receipt.
 * Linux close errors must not be retried on a possibly reused descriptor.
 *
 * This child filter complements the trusted mount/user/network configuration;
 * it does not itself implement filesystem permissions. Requires Linux pidfd,
 * close_range, seccomp-filter and a native little-endian x86_64 or arm64 ABI.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/mount.h>
#include <linux/capability.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/sched.h>
#include <linux/seccomp.h>

#if defined(__x86_64__) && !defined(__ILP32__)
#define NATIVE_AUDIT_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__) && __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__
#define NATIVE_AUDIT_ARCH AUDIT_ARCH_AARCH64
#else
#error "linux-shell-init requires native little-endian x86_64 or arm64"
#endif
#if !defined(SYS_pidfd_open) || !defined(SYS_close_range) || !defined(SYS_clone3)
#error "linux-shell-init requires current Linux syscall headers"
#endif

#define CONTROL 3
#define HANDSHAKE_MS 5000
#define REAP_MS 5000
#define MAX_GRACE_MS 5000
#define DENIED (SECCOMP_RET_ERRNO | EPERM)

static volatile sig_atomic_t caught_cancel;
static int unknown;
static const char *reason;
static void on_cancel(int sig) { (void)sig; caught_cancel = 1; }
static void choose_reason(const char *value) { if (!reason) reason = value; }
static int64_t now_ms(void) {
  struct timespec ts;
  if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) return -1;
  return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}
static void uncertain(void) { unknown = 1; }
static void close_owned(int *fd) {
  if (*fd < 0) return;
  int original = *fd;
  *fd = -1; /* A failed close cannot authorize retrying this numeric fd. */
  if (close(original) != 0) uncertain();
}
static void retain_unknown(void) __attribute__((noreturn));
static void retain_unknown(void) {
  /* Fixed diagnostic: no command, nonce, path or environment disclosure. */
  (void)write(STDERR_FILENO, "kite_linux_shell_close_unknown\n", 31);
  for (;;) pause();
}
static int configure_signals(int child) {
  sigset_t mask;
  if (sigemptyset(&mask) != 0 || sigprocmask(SIG_SETMASK, &mask, NULL) != 0)
    return -1;
  struct sigaction action;
  memset(&action, 0, sizeof action);
  if (sigemptyset(&action.sa_mask) != 0) return -1;
  action.sa_handler = SIG_DFL;
  if (sigaction(SIGCHLD, &action, NULL) != 0) return -1;
  action.sa_handler = child ? SIG_DFL : on_cancel;
  if (sigaction(SIGTERM, &action, NULL) != 0 ||
      sigaction(SIGINT, &action, NULL) != 0 ||
      sigaction(SIGHUP, &action, NULL) != 0) return -1;
  action.sa_handler = child ? SIG_DFL : SIG_IGN;
  return sigaction(SIGPIPE, &action, NULL);
}
static int valid_nonce(const char *value) {
  size_t n = strnlen(value, 129);
  if (n < 16 || n > 128) return 0;
  for (size_t i = 0; i < n; i++) {
    unsigned char c = (unsigned char)value[i];
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
          (c >= '0' && c <= '9') || c == '_' || c == '-')) return 0;
  }
  return 1;
}
static int parse_grace(const char *value, int *grace) {
  if (!*value || strlen(value) > 5) return -1;
  int result = 0;
  for (const char *p = value; *p; p++) {
    if (*p < '0' || *p > '9') return -1;
    result = result * 10 + (*p - '0');
  }
  if (result > MAX_GRACE_MS) return -1;
  *grace = result;
  return 0;
}
static int validate_control(void) {
  int type, domain;
  socklen_t length = sizeof type;
  if (getsockopt(CONTROL, SOL_SOCKET, SO_TYPE, &type, &length) != 0 ||
      length != sizeof type || type != SOCK_SEQPACKET) return -1;
  length = sizeof domain;
  if (getsockopt(CONTROL, SOL_SOCKET, SO_DOMAIN, &domain, &length) != 0 ||
      length != sizeof domain || domain != AF_UNIX) return -1;
  int flags = fcntl(CONTROL, F_GETFL);
  if (flags < 0 || fcntl(CONTROL, F_SETFL, flags | O_NONBLOCK) != 0 ||
      fcntl(CONTROL, F_SETFD, FD_CLOEXEC) != 0) return -1;
  return 0;
}
static int send_packet(const char *json, const int *fds, size_t count) {
  if (count > 2 || strlen(json) > 1024) return -1;
  union { struct cmsghdr alignment; unsigned char bytes[
    CMSG_SPACE(sizeof(int) * 2) + CMSG_SPACE(sizeof(struct ucred))]; } control;
  memset(&control, 0, sizeof control);
  struct iovec iov = { .iov_base = (void *)json, .iov_len = strlen(json) };
  struct msghdr msg;
  memset(&msg, 0, sizeof msg);
  msg.msg_iov = &iov;
  msg.msg_iovlen = 1;
  msg.msg_control = control.bytes;
  msg.msg_controllen = CMSG_SPACE(sizeof(struct ucred)) +
    (count ? CMSG_SPACE(count * sizeof(int)) : 0);
  struct cmsghdr *cmsg = CMSG_FIRSTHDR(&msg);
  if (count) {
    cmsg->cmsg_level = SOL_SOCKET;
    cmsg->cmsg_type = SCM_RIGHTS;
    cmsg->cmsg_len = CMSG_LEN(count * sizeof(int));
    memcpy(CMSG_DATA(cmsg), fds, count * sizeof(int));
    cmsg = CMSG_NXTHDR(&msg, cmsg);
  }
  if (!cmsg) return -1;
  cmsg->cmsg_level = SOL_SOCKET;
  cmsg->cmsg_type = SCM_CREDENTIALS;
  cmsg->cmsg_len = CMSG_LEN(sizeof(struct ucred));
  struct ucred credential = { .pid = getpid(), .uid = getuid(), .gid = getgid() };
  memcpy(CMSG_DATA(cmsg), &credential, sizeof credential);
  int64_t start = now_ms();
  if (start < 0) return -1;
  for (;;) {
    ssize_t sent = sendmsg(CONTROL, &msg, MSG_DONTWAIT | MSG_NOSIGNAL);
    if (sent >= 0) return (size_t)sent == iov.iov_len ? 0 : -1;
    if (errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK) return -1;
    int64_t now = now_ms();
    if (now < 0 || now - start >= HANDSHAKE_MS) return -1;
    struct pollfd pfd = { .fd = CONTROL, .events = POLLOUT };
    if (poll(&pfd, 1, 20) < 0 && errno != EINTR) return -1;
  }
}
/* recvmsg without ancillary storage discards unsolicited SCM_RIGHTS in-kernel.
 * MSG_CTRUNC still rejects the packet. We never import an external descriptor. */
static int command_byte(char *out) {
  char buffer[2];
  struct iovec iov = { .iov_base = buffer, .iov_len = sizeof buffer };
  struct msghdr msg;
  memset(&msg, 0, sizeof msg);
  msg.msg_iov = &iov;
  msg.msg_iovlen = 1;
  ssize_t n = recvmsg(CONTROL, &msg, MSG_DONTWAIT | MSG_TRUNC);
  if (n == 0) return 0;
  if (n < 0) return (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) ? 2 : -1;
  if (n != 1 || (msg.msg_flags & (MSG_TRUNC | MSG_CTRUNC))) return -1;
  *out = buffer[0];
  return 1;
}
static int await_ack(char expected) {
  int64_t start = now_ms();
  if (start < 0) return -1;
  for (;;) {
    if (caught_cancel) { choose_reason("cancel"); return -1; }
    char value = 0;
    int got = command_byte(&value);
    if (got == 0) { choose_reason("parent_eof"); return -1; }
    if (got == -1) { uncertain(); choose_reason("control_error"); return -1; }
    if (got == 1) {
      if (value == expected) return 0;
      if (value != 'C') uncertain();
      choose_reason(value == 'C' ? "cancel" : "control_error");
      return -1;
    }
    int64_t now = now_ms();
    if (now < 0 || now - start >= HANDSHAKE_MS) { uncertain(); choose_reason("control_error"); return -1; }
    struct pollfd pfd = { .fd = CONTROL, .events = POLLIN };
    if (poll(&pfd, 1, 20) < 0 && errno != EINTR) {
      uncertain(); choose_reason("control_error"); return -1;
    }
  }
}

/* The filter checks the architecture before interpreting any syscall/argument.
 * clone3's pointer cannot be safely inspected by classic BPF: ENOSYS forces
 * libc's inspectable clone fallback. io_uring's socket operations otherwise
 * bypass a direct socket syscall filter, so the ring API is unavailable here. */
struct filter_builder { struct sock_filter items[160]; size_t length; };
static void stmt(struct filter_builder *b, unsigned short code, uint32_t value) {
  if (b->length >= 160) _exit(126);
  b->items[b->length++] = (struct sock_filter)BPF_STMT(code, value);
}
static void jump(struct filter_builder *b, unsigned short code, uint32_t value,
                 unsigned char yes, unsigned char no) {
  if (b->length >= 160) _exit(126);
  b->items[b->length++] = (struct sock_filter)BPF_JUMP(code, value, yes, no);
}
static void deny_syscall(struct filter_builder *b, uint32_t number) {
  jump(b, BPF_JMP | BPF_JEQ | BPF_K, number, 0, 1);
  stmt(b, BPF_RET | BPF_K, DENIED);
}
static void socket_filter(struct filter_builder *b, uint32_t number, int mode) {
  if (mode == 2) { deny_syscall(b, number); return; }
  jump(b, BPF_JMP | BPF_JEQ | BPF_K, number, 0, mode == 1 ? 6 : 5);
  stmt(b, BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0]));
  jump(b, BPF_JMP | BPF_JEQ | BPF_K, AF_INET, mode == 1 ? 3 : 2, 0);
  jump(b, BPF_JMP | BPF_JEQ | BPF_K, AF_INET6, mode == 1 ? 2 : 1, 0);
  if (mode == 1) jump(b, BPF_JMP | BPF_JEQ | BPF_K, AF_UNIX, 1, 0);
  stmt(b, BPF_RET | BPF_K, DENIED);
  stmt(b, BPF_RET | BPF_K, SECCOMP_RET_ALLOW);
}
static int install_filter(int mode) {
  int confined = mode == 2;
  struct filter_builder b = { .length = 0 };
  stmt(&b, BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch));
  jump(&b, BPF_JMP | BPF_JEQ | BPF_K, NATIVE_AUDIT_ARCH, 1, 0);
  stmt(&b, BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS);
  stmt(&b, BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr));
#if defined(__x86_64__)
  jump(&b, BPF_JMP | BPF_JSET | BPF_K, 0x40000000U, 0, 1);
  stmt(&b, BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS);
#endif
  deny_syscall(&b, SYS_setns);
  deny_syscall(&b, SYS_unshare);
  deny_syscall(&b, SYS_mount);
  deny_syscall(&b, SYS_umount2);
  deny_syscall(&b, SYS_pivot_root);
  deny_syscall(&b, SYS_open_by_handle_at);
#ifdef SYS_fsopen
  deny_syscall(&b, SYS_fsopen);
#endif
#ifdef SYS_fsconfig
  deny_syscall(&b, SYS_fsconfig);
#endif
#ifdef SYS_fsmount
  deny_syscall(&b, SYS_fsmount);
#endif
#ifdef SYS_move_mount
  deny_syscall(&b, SYS_move_mount);
#endif
#ifdef SYS_open_tree
  deny_syscall(&b, SYS_open_tree);
#endif
#ifdef SYS_mount_setattr
  deny_syscall(&b, SYS_mount_setattr);
#endif
#ifdef SYS_io_uring_setup
  deny_syscall(&b, SYS_io_uring_setup);
  deny_syscall(&b, SYS_io_uring_enter);
  deny_syscall(&b, SYS_io_uring_register);
#endif
  jump(&b, BPF_JMP | BPF_JEQ | BPF_K, SYS_clone3, 0, 1);
  stmt(&b, BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS);
  if (confined) {
#ifdef SYS_fork
    deny_syscall(&b, SYS_fork);
#endif
#ifdef SYS_vfork
    deny_syscall(&b, SYS_vfork);
#endif
  }
  /* Both native supported ABIs pass clone flags as argument zero. Reject high
   * flags and namespace bits, including NEWTIME (0x80). Confined permits only
   * a kernel-valid CLONE_THREAD combination, never an independent child. */
  jump(&b, BPF_JMP | BPF_JEQ | BPF_K, SYS_clone, 0, confined ? 9 : 7);
  stmt(&b, BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0]) + 4);
  jump(&b, BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0);
  stmt(&b, BPF_RET | BPF_K, DENIED);
  stmt(&b, BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0]));
  jump(&b, BPF_JMP | BPF_JSET | BPF_K,
       CLONE_NEWNS | CLONE_NEWCGROUP | CLONE_NEWUTS | CLONE_NEWIPC |
       CLONE_NEWUSER | CLONE_NEWPID | CLONE_NEWNET | 0x80U, 0, 1);
  stmt(&b, BPF_RET | BPF_K, DENIED);
  if (confined) {
    jump(&b, BPF_JMP | BPF_JSET | BPF_K, CLONE_THREAD, 1, 0);
    stmt(&b, BPF_RET | BPF_K, DENIED);
  }
  stmt(&b, BPF_RET | BPF_K, SECCOMP_RET_ALLOW);
  /* Reload syscall nr after the clone block for its nonmatching path. */
  stmt(&b, BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr));
  socket_filter(&b, SYS_socket, mode);
  socket_filter(&b, SYS_socketpair, mode);
  stmt(&b, BPF_RET | BPF_K, SECCOMP_RET_ALLOW);
  struct sock_fprog program = { .len = (unsigned short)b.length, .filter = b.items };
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return -1;
  return prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program);
}
static void shell_child(int gate, const char *shell, const char *command, int mode) {
  if (configure_signals(1) != 0) _exit(126);
  char value = 0;
  ssize_t n;
  do { n = read(gate, &value, 1); } while (n < 0 && errno == EINTR);
  if (n != 1 || value != 'G' || close(gate) != 0) _exit(126);
  int nullfd = open("/dev/null", O_RDONLY | O_CLOEXEC);
  if (nullfd < 0 || dup2(nullfd, STDIN_FILENO) < 0 ||
      fcntl(STDIN_FILENO, F_SETFD, 0) != 0) _exit(126);
  /* Do not silently run with a leaked socket on older unsupported kernels. */
  if (syscall(SYS_close_range, 3U, UINT_MAX, 0U) != 0) _exit(126);
  if (install_filter(mode) != 0) _exit(126);
  execl(shell, shell, "-c", command, (char *)NULL);
  _exit(127);
}
static int reap_root(pid_t root, int *raw, int *done) {
  if (*done) return 0;
  siginfo_t info;
  memset(&info, 0, sizeof info);
  if (waitid(P_PID, (id_t)root, &info, WEXITED | WNOWAIT | WNOHANG) != 0) {
    if (errno == EINTR) return 0;
    return -1;
  }
  if (info.si_pid == 0) return 0;
  if (info.si_pid != root || (info.si_code != CLD_EXITED &&
      info.si_code != CLD_KILLED && info.si_code != CLD_DUMPED)) return -1;
  pid_t got;
  do { got = waitpid(root, raw, 0); } while (got < 0 && errno == EINTR);
  if (got != root) return -1;
  if (info.si_code == CLD_EXITED) {
    if (!WIFEXITED(*raw) || WEXITSTATUS(*raw) != info.si_status) return -1;
  } else if (!WIFSIGNALED(*raw) || WTERMSIG(*raw) != info.si_status ||
             (!!WCOREDUMP(*raw) != (info.si_code == CLD_DUMPED))) return -1;
  *done = 1;
  return 0;
}
static void namespace_signal(int sig) {
  /* PID 1 and the calling process are excluded. No host PID/PGID is used. */
  if (kill(-1, sig) != 0 && errno != ESRCH) uncertain();
}
static void finish_tree(pid_t root, int grace, int *raw, int *root_done) {
  namespace_signal(SIGTERM);
  int64_t start = now_ms();
  if (start < 0) { uncertain(); return; }
  int killing = 0;
  for (;;) {
    if (reap_root(root, raw, root_done) != 0) { uncertain(); return; }
    int empty = 0;
    if (*root_done) {
      for (;;) {
        int other;
        pid_t got = waitpid(-1, &other, WNOHANG);
        if (got > 0) continue;
        if (got == 0) break;
        if (errno == EINTR) continue;
        if (errno == ECHILD) empty = 1;
        else uncertain();
        break;
      }
    }
    if (empty) return;
    int64_t now = now_ms();
    if (now < 0 || now - start >= grace + REAP_MS) { uncertain(); return; }
    if (now - start >= grace) killing = 1;
    /* Repeated namespace-only KILL covers forks racing an earlier sweep. */
    if (killing) namespace_signal(SIGKILL);
    /* EOF-ready control must not turn the finite grace into a busy spin. */
    if (poll(NULL, 0, 20) < 0 && errno != EINTR) { uncertain(); return; }
    char late;
    int got = command_byte(&late);
    if (got == -1) uncertain();
    /* Late C/EOF cannot replace the original closing reason/root result. */
  }
}
#define MAX_PATHS 200
static const char *seal_paths[MAX_PATHS], *exec_files[MAX_PATHS], *masked_roots[MAX_PATHS];
static size_t seal_count, exec_count, mask_count;
static int listed(const char *path, const char *const *list, size_t count) {
  for (size_t i = 0; i < count; i++) if (!strcmp(path, list[i])) return 1;
  return 0;
}
static int below(const char *path, const char *root) {
  size_t n = strlen(root);
  return !strncmp(path, root, n) && path[n] == '/';
}
static int inspect_mount_path(const char *path, int executable, int masked) {
  int fd = open(path, O_PATH | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return -1;
  struct stat st;
  struct statvfs flags;
  int failed = fstat(fd, &st) != 0 || fstatvfs(fd, &flags) != 0;
  if (!failed) {
    if (executable) failed = !S_ISREG(st.st_mode) || !(flags.f_flag & ST_RDONLY) ||
      (flags.f_flag & ST_NOEXEC);
    else if (masked) failed = !S_ISDIR(st.st_mode) || (st.st_mode & 07777) ||
      !(flags.f_flag & ST_RDONLY);
  }
  close_owned(&fd);
  return failed || unknown ? -1 : 0;
}
/* mountinfo escapes only space, tab, newline and backslash. Reject malformed
 * data instead of inferring that a truncated list contains no submounts. */
static int decode_mount_path(char *text) {
  char *out = text;
  for (char *p = text; *p; p++) {
    if (*p != '\\') { *out++ = *p; continue; }
    if (!p[1] || !p[2] || !p[3] || p[1] < '0' || p[1] > '7' || p[2] < '0' ||
        p[2] > '7' || p[3] < '0' || p[3] > '7') return -1;
    int value = (p[1] - '0') * 64 + (p[2] - '0') * 8 + p[3] - '0';
    if (value != 32 && value != 9 && value != 10 && value != 92) return -1;
    *out++ = (char)value;
    p += 3;
  }
  *out = 0;
  return text[0] == '/' && strlen(text) <= PATH_MAX ? 0 : -1;
}
static int inspect_submounts(void) {
  static char data[1048577];
  size_t size = 0;
  int fd = open("/proc/self/mountinfo", O_RDONLY | O_CLOEXEC);
  if (fd < 0) return -1;
  int failed = 0;
  for (;;) {
    if (size == sizeof(data) - 1) { failed = 1; break; }
    ssize_t n = read(fd, data + size, sizeof(data) - 1 - size);
    if (n < 0) { if (errno == EINTR) continue; failed = 1; break; }
    if (n == 0) break;
    size += (size_t)n;
  }
  close_owned(&fd);
  if (failed || unknown || !size || data[size - 1] != '\n') return -1;
  data[size] = 0;
  char *line = data;
  size_t records = 0;
  while (*line) {
    if (++records > 4096) return -1;
    char *end = strchr(line, '\n');
    if (!end) return -1;
    *end = 0;
    char *field = line;
    for (int i = 1; i < 5; i++) {
      field = strchr(field, ' ');
      if (!field || !field[1] || field[1] == ' ') return -1;
      field++;
    }
    char *field_end = strchr(field, ' ');
    if (!field_end || !strstr(field_end, " - ")) return -1;
    *field_end = 0;
    if (decode_mount_path(field) != 0) return -1;
    for (size_t i = 0; i < seal_count; i++) {
      if (!below(field, seal_paths[i])) continue;
      if (listed(field, exec_files, exec_count)) {
        if (inspect_mount_path(field, 1, 0) != 0) return -1;
      } else if (listed(field, masked_roots, mask_count)) {
        if (inspect_mount_path(field, 0, 1) != 0) return -1;
      } else if (!listed(field, seal_paths, seal_count)) return -1;
    }
    line = end + 1;
  }
  return 0;
}
static unsigned long retained_mount_flags(unsigned long flags) {
  unsigned long result = 0;
  if (flags & ST_RDONLY) result |= MS_RDONLY;
  if (flags & ST_NOSUID) result |= MS_NOSUID;
  if (flags & ST_NODEV) result |= MS_NODEV;
  if (flags & ST_NOEXEC) result |= MS_NOEXEC;
  if (flags & ST_SYNCHRONOUS) result |= MS_SYNCHRONOUS;
#ifdef ST_MANDLOCK
  if (flags & ST_MANDLOCK) result |= MS_MANDLOCK;
#endif
#ifdef ST_NOATIME
  if (flags & ST_NOATIME) result |= MS_NOATIME;
#endif
#ifdef ST_NODIRATIME
  if (flags & ST_NODIRATIME) result |= MS_NODIRATIME;
#endif
#ifdef ST_RELATIME
  if (flags & ST_RELATIME) result |= MS_RELATIME;
#endif
  return result;
}
/* P is the first permission to use the retained namespace-only capability.
 * There is still no business child or untrusted code at this point. */
static int prepare_noexec(void) {
  struct __user_cap_header_struct header = { .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0 };
  struct __user_cap_data_struct caps[2];
  memset(caps, 0, sizeof caps);
  uint32_t admin = 1U << CAP_SYS_ADMIN;
  if (syscall(SYS_capget, &header, caps) != 0 ||
      caps[0].effective != admin || caps[0].permitted != admin ||
      (caps[0].inheritable & ~admin) || caps[1].effective ||
      caps[1].permitted || caps[1].inheritable) return -1;
  int failed = inspect_submounts() != 0;
  for (size_t i = 0; !failed && i < exec_count; i++)
    if (listed(exec_files[i], seal_paths, seal_count) ||
        listed(exec_files[i], masked_roots, mask_count) ||
        inspect_mount_path(exec_files[i], 1, 0) != 0) failed = 1;
  for (size_t i = 0; !failed && i < mask_count; i++)
    if (inspect_mount_path(masked_roots[i], 0, 1) != 0) failed = 1;
  for (size_t i = 0; !failed && i < seal_count; i++) {
    const char *path = seal_paths[i];
    int directory = open(path, O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (directory < 0) { failed = 1; break; }
    struct stat before, after;
    struct statvfs old_flags, new_flags;
    failed = fstat(directory, &before) != 0 || fstatvfs(directory, &old_flags) != 0;
    if (!failed) {
      unsigned long retained = retained_mount_flags(old_flags.f_flag);
      failed = mount(NULL, path, NULL, retained | MS_BIND | MS_REMOUNT |
                     MS_NOEXEC | MS_NOSUID | MS_NODEV, NULL) != 0 ||
        stat(path, &after) != 0 || before.st_dev != after.st_dev || before.st_ino != after.st_ino ||
        fstatvfs(directory, &new_flags) != 0 ||
        (new_flags.f_flag & (ST_NOEXEC | ST_NOSUID | ST_NODEV)) != (ST_NOEXEC | ST_NOSUID | ST_NODEV) ||
        (new_flags.f_flag & old_flags.f_flag) != old_flags.f_flag;
    }
    close_owned(&directory);
    if (unknown) failed = 1;
  }
  if (!failed && inspect_submounts() != 0) failed = 1;
  if (prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0) != 0) failed = 1;
  memset(caps, 0, sizeof caps);
  if (syscall(SYS_capset, &header, caps) != 0 || syscall(SYS_capget, &header, caps) != 0)
    failed = 1;
  else for (size_t i = 0; i < 2; i++)
    if (caps[i].effective || caps[i].permitted || caps[i].inheritable) failed = 1;
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) failed = 1;
  return failed || unknown ? -1 : 0;
}
static int absolute_path(const char *path) {
  size_t n = strnlen(path, PATH_MAX + 1);
  if (n < 2 || n > PATH_MAX || path[0] != '/' || path[n - 1] == '/') return 0;
  for (size_t i = 0; i < n; i++) if ((unsigned char)path[i] < 32 || path[i] == 127) return 0;
  const char *part = path + 1;
  while (*part) {
    const char *end = strchr(part, '/');
    size_t len = end ? (size_t)(end - part) : strlen(part);
    if (!len || (len == 1 && *part == '.') || (len == 2 && part[0] == '.' && part[1] == '.')) return 0;
    if (!end) break;
    part = end + 1;
  }
  return 1;
}
int main(int argc, char **argv) {
  int grace = 0;
  if (argc < 9 || argc > 209 || !valid_nonce(argv[1]) || parse_grace(argv[2], &grace) != 0 ||
      !absolute_path(argv[3]) || !absolute_path(argv[6]) ||
      strnlen(argv[4], 1048577) > 1048576 ||
      (strcmp(argv[5], "workspace") && strcmp(argv[5], "full") && strcmp(argv[5], "confined")) || getpid() != 1)
    return 125; /* No owned child exists before these checks. */
  int confined = !strcmp(argv[5], "confined");
  int section = 0;
  size_t argument_bytes = 0, path_count = 0;
  for (int i = 1; i < argc; i++) {
    size_t size = strnlen(argv[i], 1048577);
    if (size >= 1048576 || argument_bytes > 1048576 - size - 1) return 125;
    argument_bytes += size + 1;
    if (i < 6) continue;
    if (!strcmp(argv[i], "--exec-assets")) {
      if (section != 0 || !seal_count) return 125;
      section = 1; continue;
    }
    if (!strcmp(argv[i], "--masked-roots")) {
      if (section != 1) return 125;
      section = 2; continue;
    }
    if (++path_count > MAX_PATHS || !absolute_path(argv[i])) return 125;
    if (section == 0) seal_paths[seal_count++] = argv[i];
    else if (section == 1) exec_files[exec_count++] = argv[i];
    else masked_roots[mask_count++] = argv[i];
  }
  if (section != 2 || (!confined && seal_count != 1)) return 125;
  if (confined) {
    char cwd[PATH_MAX + 1];
    if (!getcwd(cwd, sizeof cwd) || seal_count < 2 ||
        !listed(cwd, seal_paths + 1, seal_count - 1)) return 125;
  }
  /* Masked roots are independently trusted mode-000 readonly directories.
   * Also seal them, retaining readonly; no ordinary nested mount is inferred
   * to be a mask merely because its path lies inside an authorized root. */
  for (size_t i = 0; i < mask_count; i++) {
    if (!listed(masked_roots[i], seal_paths, seal_count)) {
      if (seal_count == MAX_PATHS) return 125;
      seal_paths[seal_count++] = masked_roots[i];
    }
  }
  if (configure_signals(0) != 0 || validate_control() != 0 ||
      prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 ||
      prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) retain_unknown();
  int self_fd = (int)syscall(SYS_pidfd_open, getpid(), 0);
  int ns_fd = open("/proc/self/ns/pid", O_RDONLY | O_CLOEXEC);
  int root_fd = -1, gate[2] = {-1, -1};
  struct stat ns;
  if (self_fd < 0 || ns_fd < 0 || fstat(ns_fd, &ns) != 0) retain_unknown();
  char packet[1024];
  int length = snprintf(packet, sizeof packet,
    "{\"version\":1,\"type\":\"namespace\",\"nonce\":\"%s\",\"initLocalPid\":1,"
    "\"namespace\":{\"dev\":\"%ju\",\"ino\":\"%ju\"}}",
    argv[1], (uintmax_t)ns.st_dev, (uintmax_t)ns.st_ino);
  int ns_rights[2] = {self_fd, ns_fd};
  if (length < 0 || (size_t)length >= sizeof packet ||
      send_packet(packet, ns_rights, 2) != 0 || await_ack('P') != 0)
    retain_unknown(); /* No fictitious root receipt before P. */
  if (prepare_noexec() != 0 || caught_cancel) retain_unknown();
  if (pipe2(gate, O_CLOEXEC) != 0) retain_unknown();
  pid_t root = fork();
  if (root < 0) retain_unknown();
  if (root == 0) {
    if (close(gate[1]) != 0) _exit(126);
    shell_child(gate[0], argv[3], argv[4], !strcmp(argv[5], "confined") ? 2 : !strcmp(argv[5], "full") ? 1 : 0);
    _exit(126);
  }
  close_owned(&gate[0]);
  root_fd = (int)syscall(SYS_pidfd_open, root, 0);
  if (root_fd < 0) uncertain();
  if (unknown) choose_reason("startup_error");
  if (!reason) {
    length = snprintf(packet, sizeof packet,
      "{\"version\":1,\"type\":\"root\",\"nonce\":\"%s\",\"localPid\":%d}",
      argv[1], (int)root);
    if (length < 0 || (size_t)length >= sizeof packet ||
        send_packet(packet, &root_fd, 1) != 0) { uncertain(); choose_reason("control_error"); }
    else if (await_ack('G') == 0) {
      ssize_t sent;
      do { sent = write(gate[1], "G", 1); } while (sent < 0 && errno == EINTR);
      if (sent != 1) { uncertain(); choose_reason("startup_error"); }
    }
  }
  close_owned(&gate[1]);
  int raw = 0, root_done = 0;
  while (!reason) {
    if (caught_cancel) { choose_reason("cancel"); break; }
    if (reap_root(root, &raw, &root_done) != 0) {
      uncertain(); choose_reason("control_error"); break;
    }
    if (root_done) { choose_reason("natural"); break; }
    char value = 0;
    int got = command_byte(&value);
    if (got == 0) choose_reason("parent_eof");
    else if (got == -1 || (got == 1 && value != 'C')) { uncertain(); choose_reason("control_error"); }
    else if (got == 1) choose_reason("cancel");
    if (reason) break;
    struct pollfd waiters[2] = {{ .fd = CONTROL, .events = POLLIN },
                               { .fd = root_fd, .events = POLLIN }};
    if (poll(waiters, 2, 20) < 0 && errno != EINTR) {
      uncertain(); choose_reason("control_error");
    }
  }
  finish_tree(root, grace, &raw, &root_done);
  if (!root_done || unknown) retain_unknown();
  close_owned(&root_fd);
  close_owned(&ns_fd);
  close_owned(&self_fd);
  for (int fd = 0; fd < 3; fd++) { int original = fd; close_owned(&original); }
  if (unknown) retain_unknown();
  char code[16] = "null", signal_number[16] = "null";
  if (WIFEXITED(raw)) snprintf(code, sizeof code, "%d", WEXITSTATUS(raw));
  else if (WIFSIGNALED(raw)) snprintf(signal_number, sizeof signal_number, "%d", WTERMSIG(raw));
  else retain_unknown();
  length = snprintf(packet, sizeof packet,
    "{\"version\":1,\"type\":\"terminal\",\"nonce\":\"%s\",\"reason\":\"%s\","
    "\"root\":{\"localPid\":%d,\"code\":%s,\"signal\":%s,\"rawStatus\":%d,"
    "\"waitConfirmed\":true,\"reaped\":true},\"treeStopped\":true,\"closed\":true}",
    argv[1], reason, (int)root, code, signal_number, raw);
  if (length < 0 || (size_t)length >= sizeof packet || send_packet(packet, NULL, 0) != 0)
    retain_unknown();
  int control_fd = CONTROL;
  close_owned(&control_fd);
  if (unknown) retain_unknown();
  _exit(0);
}
