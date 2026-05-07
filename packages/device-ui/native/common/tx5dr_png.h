#pragma once
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
int tx5dr_write_rgba_png(const char *path, int width, int height, const unsigned char *rgba);
#ifdef __cplusplus
}
#endif
