#pragma once
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
#define TX5DR_IPC_MAX_LINE 65536
typedef void (*tx5dr_ipc_line_cb)(const char *line, void *user);
int tx5dr_ipc_connect(const char *socket_path);
void tx5dr_ipc_send_json(int fd, const char *json);
void tx5dr_ipc_read_for(int fd, int timeout_ms, tx5dr_ipc_line_cb cb, void *user);
#ifdef __cplusplus
}
#endif
