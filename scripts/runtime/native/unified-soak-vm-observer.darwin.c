/* Private Darwin diagnostic. POSIX VM imports after constructor only; not live
 * blocks, all VM APIs or formal resource qualification. Apple dyld excludes this
 * image from its static interpose replacement, so these calls forward unchanged.
 */
#define _DARWIN_C_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <execinfo.h>
#include <fcntl.h>
#include <inttypes.h>
#include <libproc.h>
#include <mach/mach_time.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

static _Atomic int trace_fd = -1;
static pthread_mutex_t trace_lock = PTHREAD_MUTEX_INITIALIZER;
static _Thread_local int observing;
static uint64_t sequence;
static uint64_t write_errors;
static _Atomic uint64_t nested_calls;

struct record {
  char bytes[16384];
  size_t size;
  int failed;
};

static void output(int fd, const char *bytes, size_t size) {
  size_t offset = 0;
  while (offset < size) {
    ssize_t n = write(fd, bytes + offset, size - offset);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) {
      write_errors++;
      return;
    }
    offset += (size_t)n;
  }
}

static void append(struct record *record, const char *format, ...) {
  if (record->failed) return;
  va_list args;
  va_start(args, format);
  size_t available = sizeof(record->bytes) - record->size;
  int n = vsnprintf(record->bytes + record->size, available, format, args);
  va_end(args);
  if (n < 0 || (size_t)n >= available) {
    record->failed = 1;
    return;
  }
  record->size += (size_t)n;
}

static void append_string(struct record *record, const char *value) {
  if (!value) {
    append(record, "null");
    return;
  }
  append(record, "\"");
  for (const unsigned char *p = (const unsigned char *)value;
       *p && !record->failed; p++) {
    if (*p == '"' || *p == '\\') append(record, "\\%c", *p);
    else if (*p < 32) append(record, "\\u%04x", *p);
    else append(record, "%c", *p);
  }
  append(record, "\"");
}

static void trace(const char *kind, void *requested_address, void *address,
                  size_t length, int arg, int result, int error, int protection,
                  int flags, off_t offset, uint64_t entered) {
  if (atomic_load(&trace_fd) < 0) return;
  if (observing) {
    atomic_fetch_add(&nested_calls, 1);
    return;
  }
  observing = 1;
  uint64_t thread = 0;
  int thread_error = pthread_threadid_np(NULL, &thread);
  uint64_t completed = mach_absolute_time();
  void *frames[24];
  int count = backtrace(frames, 24);
  struct record record = {0};
  append(&record,
         "{\"kind\":\"%s\",\"pid\":%d,\"thread\":\"%" PRIu64
         "\",\"threadError\":%d,\"startedTicks\":\"%" PRIu64
         "\",\"completedTicks\":\"%" PRIu64
         "\",\"protection\":%d,\"flags\":%d,\"offset\":\"%" PRId64
         "\",\"requestedAddress\":\"0x%" PRIxPTR
         "\",\"address\":\"0x%" PRIxPTR
         "\",\"length\":\"%zu\",\"arg\":%d,\"result\":%d,\"errno\":%d,\"frames\":[",
         kind, getpid(), thread, thread_error, entered, completed, protection,
         flags, (int64_t)offset, (uintptr_t)requested_address, (uintptr_t)address,
         length, arg, result, error);
  for (int i = 0; i < count && !record.failed; i++) {
    Dl_info image = {0};
    (void)dladdr(frames[i], &image);
    append(&record,
           "%s{\"pc\":\"0x%" PRIxPTR "\",\"base\":\"0x%" PRIxPTR
           "\",\"symbolAddress\":\"0x%" PRIxPTR "\",\"image\":",
           i ? "," : "", (uintptr_t)frames[i], (uintptr_t)image.dli_fbase,
           (uintptr_t)image.dli_saddr);
    append_string(&record, image.dli_fname);
    append(&record, ",\"symbol\":");
    append_string(&record, image.dli_sname);
    append(&record, "}");
  }
  pthread_mutex_lock(&trace_lock);
  int fd = atomic_load(&trace_fd);
  if (fd >= 0) {
    append(&record, "],\"sequence\":\"%" PRIu64 "\",\"frameLimit\":24}\n",
           sequence);
    if (record.failed) write_errors++;
    else {
      sequence++;
      output(fd, record.bytes, record.size);
    }
  }
  pthread_mutex_unlock(&trace_lock);
  observing = 0;
}

__attribute__((constructor)) static void begin(void) {
  observing = 1;
  const char *path = getenv("KITE_RSS_VM_TRACE");
  int fd = -1;
  if (path && path[0] == '/')
    fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd >= 0) {
    struct proc_bsdinfo birth = {0};
    int observed = proc_pidinfo(getpid(), PROC_PIDTBSDINFO, 0, &birth, sizeof(birth));
    struct mach_timebase_info scale = {0};
    int scale_error = mach_timebase_info(&scale);
    char text[768];
    int n = snprintf(text, sizeof(text),
                     "{\"kind\":\"begin\",\"version\":2,\"pid\":%d,"
                     "\"birthSeconds\":\"%" PRIu64 "\",\"birthMicroseconds\":\"%" PRIu64
                     "\",\"birthBytes\":%d,\"birthExpected\":%zu,"
                     "\"timeNumer\":%u,\"timeDenom\":%u,\"timeError\":%d,"
                     "\"scope\":\"after-constructor POSIX VM imports, not live blocks or whole VM\"}\n",
                     getpid(), birth.pbi_start_tvsec, birth.pbi_start_tvusec,
                     observed, sizeof(birth), scale.numer, scale.denom, scale_error);
    if (n > 0 && (size_t)n < sizeof(text)) output(fd, text, (size_t)n);
    else write_errors++;
    atomic_store(&trace_fd, fd);
  }
  observing = 0;
}

__attribute__((destructor)) static void finish(void) {
  observing = 1;
  pthread_mutex_lock(&trace_lock);
  int fd = atomic_load(&trace_fd);
  if (fd >= 0) {
    char text[512];
    int n = snprintf(text, sizeof(text),
                     "{\"kind\":\"finish\",\"pid\":%d,\"events\":\"%" PRIu64
                     "\",\"writeErrors\":\"%" PRIu64 "\",\"nestedCalls\":\"%" PRIu64 "\"}\n",
                     getpid(), sequence, write_errors, atomic_load(&nested_calls));
    if (n > 0 && (size_t)n < sizeof(text)) output(fd, text, (size_t)n);
    (void)atomic_exchange(&trace_fd, -1);
    (void)close(fd);
  }
  pthread_mutex_unlock(&trace_lock);
}

void kite_rss_mark(int label) {
  int saved = errno;
  trace("mark", NULL, NULL, 0, label, 0, 0, 0, 0, 0, mach_absolute_time());
  errno = saved;
}

static void *observe_mmap(void *address, size_t length, int protection, int flags,
                          int fd, off_t offset) {
  uint64_t entered = mach_absolute_time();
  void *result = mmap(address, length, protection, flags, fd, offset);
  int saved = errno;
  trace("mmap", address, result, length, fd, result == MAP_FAILED ? -1 : 0,
        result == MAP_FAILED ? saved : 0, protection, flags, offset, entered);
  errno = saved;
  return result;
}

static int observe_munmap(void *address, size_t length) {
  uint64_t entered = mach_absolute_time();
  int result = munmap(address, length);
  int saved = errno;
  trace("munmap", NULL, address, length, 0, result, result ? saved : 0, 0, 0, 0, entered);
  errno = saved;
  return result;
}

static int observe_madvise(void *address, size_t length, int advice) {
  uint64_t entered = mach_absolute_time();
  int result = madvise(address, length, advice);
  int saved = errno;
  trace("madvise", NULL, address, length, advice, result, result ? saved : 0, 0, 0, 0, entered);
  errno = saved;
  return result;
}

#define INTERPOSE(replacement, original) \
  __attribute__((used)) static struct { const void *to; const void *from; } \
    replacement##_tuple __attribute__((section("__DATA,__interpose"))) = \
      {(const void *)(uintptr_t)&replacement, (const void *)(uintptr_t)&original}
INTERPOSE(observe_mmap, mmap);
INTERPOSE(observe_munmap, munmap);
INTERPOSE(observe_madvise, madvise);
