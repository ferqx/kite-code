#include <signal.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

/* Ordinary workspace program: a different session and a genuinely orphaned
 * descendant stay alive until the default Shell owner stops their coalition. */
static void hold(void) {
  alarm(90);
  signal(SIGTERM, SIG_IGN);
  close(0);
  close(1);
  close(2);
  for (;;) pause();
}

static int saved(const char *port, const char *label, const char *stream, int bytes) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return 106;
  struct sockaddr_in address = {0};
  address.sin_family = AF_INET;
  address.sin_port = htons((unsigned short)atoi(port));
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (connect(fd, (struct sockaddr *)&address, sizeof(address))) return 107;
  char request[512], response[128];
  int size = snprintf(request, sizeof(request),
    "GET /control/flush?label=%s&stream=%s&bytes=%d HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
    label, stream, bytes);
  if (size <= 0 || size >= (int)sizeof(request) || write(fd, request, size) != size) return 108;
  ssize_t count = 0;
  while (count < (ssize_t)sizeof(response)-1) {
    ssize_t received = read(fd, response+count, sizeof(response)-1-count);
    if (received <= 0) { close(fd); return 109; }
    count += received;
    response[count] = 0;
    if (strchr(response, '\n')) break;
  }
  close(fd);
  if (count <= 0) return 109;
  response[count] = 0;
  return strstr(response, " 200 ") ? 0 : 110;
}

int main(int argc, char **argv) {
  if (argc != 5) return 90;
  alarm(90);
  int channel[2];
  if (pipe(channel)) return 91;
  pid_t child = fork();
  if (child < 0) return 92;
  if (child == 0) {
    close(channel[0]);
    if (setsid() < 0) _exit(93);
    pid_t intermediate = fork();
    if (intermediate < 0) _exit(94);
    if (intermediate == 0) {
      pid_t orphan = fork();
      if (orphan < 0) _exit(95);
      if (orphan == 0) {
        pid_t pid = getpid();
        if (write(channel[1], &pid, sizeof(pid)) != sizeof(pid)) _exit(96);
        close(channel[1]);
        hold();
      }
      _exit(0);
    }
    close(channel[1]);
    if (waitpid(intermediate, NULL, 0) != intermediate) _exit(97);
    hold();
  }
  close(channel[1]);
  pid_t orphan;
  if (read(channel[0], &orphan, sizeof(orphan)) != sizeof(orphan)) return 98;
  close(channel[0]);
  FILE *identity = fopen(argv[1], "w");
  if (!identity) return 102;
  fprintf(identity, "%d %d %d\n", getpid(), child, orphan);
  if (fclose(identity)) return 103;
  FILE *effect = fopen(argv[2], "a");
  if (!effect) return 104;
  fprintf(effect, "%s\n", argv[3]);
  if (fclose(effect)) return 105;
  /* The external fixture only reads actual durable output. Blocking on its
   * receipt paces this byte-integrity journey without background timer jitter
   * or assuming a disk can consume arbitrary bursts without recorded gaps. */
  const char *line = "默认后台输出🙂漢字𠮷\n";
  if (setvbuf(stdout, NULL, _IOFBF, 32768) || setvbuf(stderr, NULL, _IOFBF, 32768)) return 111;
  for (int stream = 1; stream <= 2; stream++) {
    FILE *output = stream == 1 ? stdout : stderr;
    for (int i = 0; i < 6000; i++) {
      if (fputs(line, output) == EOF) return 99;
      if (i % 100 == 99) {
        if (fflush(output)) return 100;
        int result = saved(argv[4], argv[3], stream == 1 ? "stdout" : "stderr",
          (i+1)*(int)strlen(line));
        if (result) return result;
      }
    }
    if (fflush(output)) return 101;
  }
  signal(SIGTERM, SIG_IGN);
  for (;;) pause();
}
