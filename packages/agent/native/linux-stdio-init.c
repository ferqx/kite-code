/* Trusted direct-program PID-namespace init for MCP. Fixed argv: nonce graceMs.
 * fd0/1/2 are business stdio, fd3 is private SO_SEQPACKET control with kernel
 * credentials/pidfds; fd4 is the bounded private KITEMCP1 configuration pipe.
 * The root is created behind G, inherits only 0/1/2 and directly execve's the
 * original argv/env. No Shell expansion, filesystem or network sandbox.
 * All original namespace/root waits and descriptor closes must confirm.
 * Any uncertain close/wait retains the owner, never fabricates completion.
 */
#define _GNU_SOURCE
#include <dirent.h>
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
#include <sys/vfs.h>
#include <linux/magic.h>
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
#error "linux-stdio-init requires native little-endian x86_64 or arm64"
#endif
#if !defined(SYS_pidfd_open) || !defined(SYS_close_range) || !defined(SYS_clone3)
#error "linux-stdio-init requires current Linux syscall headers"
#endif

#define CONTROL 3
#define HANDSHAKE_MS 5000
#define REAP_MS 4000
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
  (void)write(STDERR_FILENO, "kite_linux_stdio_close_unknown\n", sizeof("kite_linux_stdio_close_unknown\n") - 1);
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

/* Original program argv/environment arrive only on the bounded private pipe. */
#define CONFIG_FD 4
#define CONFIG_MAX (256 * 1024)
static unsigned char config[CONFIG_MAX + 1];
static size_t config_size, config_at;
static char *program, *working_directory, *arguments[130], *environment[129];
static uint32_t integer(void) {
  if (config_at + 4 > config_size) return UINT32_MAX;
  const unsigned char *p = config + config_at; config_at += 4;
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
/* Reject overlong encodings, surrogate code points and values above U+10FFFF.
 * Empty arguments and environment values remain valid original strings. */
static int valid_utf8(const unsigned char *p, size_t n) {
  size_t i = 0;
  while (i < n) {
    unsigned char first = p[i++];
    if (first < 0x80) continue;
    size_t rest;
    unsigned char low = 0x80, high = 0xbf;
    if (first >= 0xc2 && first <= 0xdf) rest = 1;
    else if (first >= 0xe0 && first <= 0xef) {
      rest = 2;
      if (first == 0xe0) low = 0xa0;
      if (first == 0xed) high = 0x9f;
    } else if (first >= 0xf0 && first <= 0xf4) {
      rest = 3;
      if (first == 0xf0) low = 0x90;
      if (first == 0xf4) high = 0x8f;
    } else return 0;
    if (rest > n - i || p[i] < low || p[i] > high) return 0;
    i++;
    for (size_t j = 1; j < rest; j++, i++)
      if (p[i] < 0x80 || p[i] > 0xbf) return 0;
  }
  return 1;
}
static char *field(size_t maximum) {
  uint32_t n = integer();
  if (n > maximum || config_at + n > config_size ||
      memchr(config + config_at, 0, n) || !valid_utf8(config + config_at, n)) return NULL;
  char *value = malloc((size_t)n + 1);
  if (!value) return NULL;
  memcpy(value, config + config_at, n); value[n] = 0; config_at += n;
  return value;
}
static int read_configuration(void) {
  for (;;) {
    ssize_t n = read(CONFIG_FD, config + config_size, sizeof(config) - config_size);
    if (n < 0) { if (errno == EINTR) continue; return -1; }
    if (n == 0) break;
    config_size += (size_t)n;
    if (config_size > CONFIG_MAX) return -1;
  }
  int fd = CONFIG_FD; close_owned(&fd);
  if (unknown || config_size < 16 || memcmp(config, "KITEMCP1", 8)) return -1;
  config_at = 8;
  uint32_t argc = integer(), envc = integer();
  if (argc > 128 || envc > 128) return -1;
  program = field(PATH_MAX); working_directory = field(PATH_MAX);
  if (!program || !working_directory || program[0] != '/' || working_directory[0] != '/') return -1;
  arguments[0] = program;
  for (uint32_t i = 0; i < argc; i++) if (!(arguments[i + 1] = field(32768))) return -1;
  for (uint32_t i = 0; i < envc; i++) {
    environment[i] = field(32897);
    if (!environment[i] || !strchr(environment[i], '=') || environment[i][0] == '=') return -1;
  }
  return config_at == config_size ? 0 : -1;
}
static int clear_capabilities(void) {
  struct __user_cap_header_struct header = { .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0 };
  struct __user_cap_data_struct caps[2];
  memset(caps, 0, sizeof caps);
  if (prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0) != 0 ||
      syscall(SYS_capset, &header, caps) != 0 || syscall(SYS_capget, &header, caps) != 0) return -1;
  for (size_t i = 0; i < 2; i++)
    if (caps[i].effective || caps[i].permitted || caps[i].inheritable) return -1;
  return 0;
}
static void program_child(int gate) {
  if (configure_signals(1) != 0) _exit(126);
  char value = 0; ssize_t n;
  do { n = read(gate, &value, 1); } while (n < 0 && errno == EINTR);
  if (n != 1 || value != 'G' || close(gate) != 0) _exit(126);
  if (syscall(SYS_close_range, 3U, UINT_MAX, 0U) != 0 ||
      chdir(working_directory) != 0 ||
      clear_capabilities() != 0) _exit(126);
  execve(program, arguments, environment);
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
int main(int argc, char **argv) {
  int grace = 0;
  if (argc != 3 || !valid_nonce(argv[1]) || parse_grace(argv[2], &grace) != 0 ||
      getpid() != 1) return 125;
  if (configure_signals(0) != 0 || validate_control() != 0 ||
      prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 ||
      prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) retain_unknown();
  if (read_configuration() != 0 || clear_capabilities() != 0) retain_unknown();
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
  if (caught_cancel) retain_unknown();
  if (pipe2(gate, O_CLOEXEC) != 0) retain_unknown();
  pid_t root = fork();
  if (root < 0) retain_unknown();
  if (root == 0) {
    if (close(gate[1]) != 0) _exit(126);
    program_child(gate[0]);
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
