#include "tx5dr_ipc.h"
#include <errno.h>
#include <poll.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/un.h>
#include <unistd.h>

static long now_ms(void) {
  struct timeval tv;
  gettimeofday(&tv, NULL);
  return (long)tv.tv_sec * 1000L + (long)tv.tv_usec / 1000L;
}

int tx5dr_ipc_connect(const char *socket_path) {
  if (!socket_path || !socket_path[0]) return -1;
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  struct sockaddr_un addr;
  memset(&addr, 0, sizeof(addr));
  addr.sun_family = AF_UNIX;
  snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", socket_path);
  if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
    close(fd);
    return -1;
  }
  return fd;
}

void tx5dr_ipc_send_json(int fd, const char *json) {
  if (fd < 0 || !json) return;
  (void)write(fd, json, strlen(json));
  (void)write(fd, "\n", 1);
}

void tx5dr_ipc_read_for(int fd, int timeout_ms, tx5dr_ipc_line_cb cb, void *user) {
  if (fd < 0 || timeout_ms <= 0 || !cb) return;
  char buf[TX5DR_IPC_MAX_LINE + 1];
  size_t used = 0;
  long until = now_ms() + timeout_ms;
  while (now_ms() < until) {
    struct pollfd pfd;
    pfd.fd = fd;
    pfd.events = POLLIN;
    pfd.revents = 0;
    int wait = (int)(until - now_ms());
    if (wait < 1) wait = 1;
    int pr = poll(&pfd, 1, wait);
    if (pr <= 0) break;
    char tmp[2048];
    ssize_t n = read(fd, tmp, sizeof(tmp));
    if (n <= 0) break;
    for (ssize_t i = 0; i < n; i++) {
      if (tmp[i] == '\n') {
        buf[used] = '\0';
        cb(buf, user);
        used = 0;
      } else if (used < TX5DR_IPC_MAX_LINE) {
        buf[used++] = tmp[i];
      } else {
        used = 0;
        tx5dr_ipc_send_json(fd, "{\"v\":1,\"t\":\"ipc.error\",\"ts\":0,\"payload\":{\"message\":\"message too large\"}}");
      }
    }
  }
}
