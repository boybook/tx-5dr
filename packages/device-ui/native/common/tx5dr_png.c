#include "tx5dr_png.h"
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <zlib.h>

static void put_be32(FILE *f, uint32_t v) {
  fputc((int)((v >> 24) & 255), f);
  fputc((int)((v >> 16) & 255), f);
  fputc((int)((v >> 8) & 255), f);
  fputc((int)(v & 255), f);
}

static int write_chunk(FILE *f, const char type[4], const unsigned char *data, size_t len) {
  put_be32(f, (uint32_t)len);
  fwrite(type, 1, 4, f);
  if (len && fwrite(data, 1, len, f) != len) return -1;
  uint32_t crc = crc32(0L, Z_NULL, 0);
  crc = crc32(crc, (const Bytef *)type, 4);
  if (len) crc = crc32(crc, data, (uInt)len);
  put_be32(f, crc);
  return ferror(f) ? -1 : 0;
}

int tx5dr_write_rgba_png(const char *path, int width, int height, const unsigned char *rgba) {
  if (!path || width <= 0 || height <= 0 || !rgba) return -1;
  const size_t stride = (size_t)width * 4;
  const size_t raw_len = ((size_t)width * 4 + 1) * (size_t)height;
  unsigned char *raw = (unsigned char *)malloc(raw_len);
  if (!raw) return -1;
  for (int y = 0; y < height; y++) {
    raw[(size_t)y * (stride + 1)] = 0;
    memcpy(raw + (size_t)y * (stride + 1) + 1, rgba + (size_t)y * stride, stride);
  }

  uLongf comp_cap = compressBound((uLong)raw_len);
  unsigned char *comp = (unsigned char *)malloc(comp_cap);
  if (!comp) {
    free(raw);
    return -1;
  }
  int zr = compress2(comp, &comp_cap, raw, (uLong)raw_len, Z_BEST_SPEED);
  free(raw);
  if (zr != Z_OK) {
    free(comp);
    return -1;
  }

  FILE *f = fopen(path, "wb");
  if (!f) {
    free(comp);
    return -1;
  }
  static const unsigned char sig[8] = {137, 80, 78, 71, 13, 10, 26, 10};
  fwrite(sig, 1, sizeof(sig), f);
  unsigned char ihdr[13];
  ihdr[0] = (unsigned char)((width >> 24) & 255);
  ihdr[1] = (unsigned char)((width >> 16) & 255);
  ihdr[2] = (unsigned char)((width >> 8) & 255);
  ihdr[3] = (unsigned char)(width & 255);
  ihdr[4] = (unsigned char)((height >> 24) & 255);
  ihdr[5] = (unsigned char)((height >> 16) & 255);
  ihdr[6] = (unsigned char)((height >> 8) & 255);
  ihdr[7] = (unsigned char)(height & 255);
  ihdr[8] = 8;   /* bit depth */
  ihdr[9] = 6;   /* RGBA */
  ihdr[10] = 0;  /* compression */
  ihdr[11] = 0;  /* filter */
  ihdr[12] = 0;  /* interlace */
  int ok = write_chunk(f, "IHDR", ihdr, sizeof(ihdr)) == 0 &&
           write_chunk(f, "IDAT", comp, (size_t)comp_cap) == 0 &&
           write_chunk(f, "IEND", NULL, 0) == 0;
  free(comp);
  fclose(f);
  return ok ? 0 : -1;
}
