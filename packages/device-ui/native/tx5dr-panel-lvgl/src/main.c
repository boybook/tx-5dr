#include "tx5dr_ipc.h"
#include "tx5dr_png.h"
#include <ctype.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <unistd.h>
#ifdef TX5DR_HAS_SDL
#include <SDL.h>
#endif

typedef struct {
  char backend[16];
  char profile[64];
  char socket_path[256];
  char snapshot[256];
  int scale;
  int once_ms;
  int hold_ms;
} Options;

typedef struct {
  char screen[32];
  char network[64];
  char ip[64];
  char url[128];
  char pairing[32];
  char server[32];
  char engine[32];
  char freq[64];
  char current_tx[128];
  char recent[128];
  int ptt;
  int spectrum[64];
  int spectrum_len;
  int ipc_fd;
} PanelState;

static unsigned char *g_fb;
static const int W = 320;
static const int H = 480;

static long now_ms(void) {
  struct timeval tv;
  gettimeofday(&tv, NULL);
  return (long)tv.tv_sec * 1000L + (long)tv.tv_usec / 1000L;
}

static void defaults(Options *o, PanelState *s) {
  memset(o, 0, sizeof(*o));
  strcpy(o->backend, "png");
  strcpy(o->profile, "tft-ili9486-320x480-touch");
  o->scale = 2;
  o->once_ms = 1200;
  o->hold_ms = 600000;
  memset(s, 0, sizeof(*s));
  strcpy(s->screen, "boot");
  strcpy(s->network, "offline");
  strcpy(s->server, "connecting");
  strcpy(s->engine, "unknown");
  strcpy(s->url, "http://tx5dr.local:8076");
  strcpy(s->pairing, "------");
  strcpy(s->freq, "14.074 MHz");
  strcpy(s->recent, "Waiting for device-ui state");
  s->spectrum_len = 64;
  for (int i = 0; i < 64; i++) s->spectrum[i] = (i * 17) % 100;
}

static const char *arg_value(const char *arg, const char *name) {
  size_t n = strlen(name);
  return strncmp(arg, name, n) == 0 && arg[n] == '=' ? arg + n + 1 : NULL;
}

static void parse_args(int argc, char **argv, Options *o) {
  for (int i = 1; i < argc; i++) {
    const char *v;
    if ((v = arg_value(argv[i], "--backend"))) snprintf(o->backend, sizeof(o->backend), "%s", v);
    else if ((v = arg_value(argv[i], "--profile"))) snprintf(o->profile, sizeof(o->profile), "%s", v);
    else if ((v = arg_value(argv[i], "--socket"))) snprintf(o->socket_path, sizeof(o->socket_path), "%s", v);
    else if ((v = arg_value(argv[i], "--snapshot"))) snprintf(o->snapshot, sizeof(o->snapshot), "%s", v);
    else if ((v = arg_value(argv[i], "--scale"))) o->scale = atoi(v) > 0 ? atoi(v) : 2;
    else if ((v = arg_value(argv[i], "--once-ms"))) o->once_ms = atoi(v) > 0 ? atoi(v) : 1200;
    else if ((v = arg_value(argv[i], "--hold-ms"))) o->hold_ms = atoi(v) > 0 ? atoi(v) : 600000;
  }
}

static void fill_rect(int x, int y, int w, int h, uint32_t c) {
  if (!g_fb) return;
  if (x < 0) { w += x; x = 0; }
  if (y < 0) { h += y; y = 0; }
  if (x + w > W) w = W - x;
  if (y + h > H) h = H - y;
  for (int yy = y; yy < y + h; yy++) {
    for (int xx = x; xx < x + w; xx++) {
      unsigned char *p = g_fb + ((yy * W + xx) * 4);
      p[0] = (unsigned char)((c >> 24) & 255);
      p[1] = (unsigned char)((c >> 16) & 255);
      p[2] = (unsigned char)((c >> 8) & 255);
      p[3] = 255;
    }
  }
}

static void draw_char(int x, int y, char ch, uint32_t c, int scale) {
  unsigned v = (unsigned char)ch;
  for (int row = 0; row < 7; row++) {
    for (int col = 0; col < 5; col++) {
      int edge = row == 0 || row == 6 || col == 0 || col == 4;
      int bit = ((v >> ((row + col) % 6)) & 1) || (edge && ch != ' ');
      if (bit) fill_rect(x + col * scale, y + row * scale, scale, scale, c);
    }
  }
}

static void draw_text(int x, int y, const char *text, uint32_t c, int scale) {
  for (int i = 0; text && text[i] && x < W - 8; i++) {
    if (text[i] == '\n') { y += 9 * scale; x = 10; continue; }
    draw_char(x, y, text[i], c, scale);
    x += 6 * scale;
  }
}

static void draw_bar(int x, int y, int w, int h, int pct, uint32_t c) {
  fill_rect(x, y, w, h, 0x203040ffu);
  if (pct < 0) pct = 0;
  if (pct > 100) pct = 100;
  fill_rect(x, y, (w * pct) / 100, h, c);
}

static void render(const PanelState *s) {
  fill_rect(0, 0, W, H, 0x101820ffu);
  fill_rect(0, 0, W, 34, s->ptt ? 0xa32626ffu : 0x143b52ffu);
  char line[256];
  snprintf(line, sizeof(line), "TX-5DR %s %s", s->network, s->ip);
  draw_text(10, 10, line, 0xe8f6ffffu, 2);
  fill_rect(0, 35, W, 3, 0x2bd4bdffu);

  snprintf(line, sizeof(line), "Screen: %s", s->screen);
  draw_text(16, 55, line, 0xffffffffu, 2);
  snprintf(line, sizeof(line), "Server %s / Engine %s", s->server, s->engine);
  draw_text(16, 84, line, 0xb8d8e8ffu, 2);

  if (strcmp(s->screen, "monitor") == 0 || s->ptt) {
    draw_text(16, 130, "MONITOR", 0x2bd4bdffu, 3);
    snprintf(line, sizeof(line), "Freq %s  PTT %s", s->freq, s->ptt ? "ON" : "off");
    draw_text(16, 170, line, 0xffffffffu, 2);
    snprintf(line, sizeof(line), "TX %s", s->current_tx[0] ? s->current_tx : "idle");
    draw_text(16, 202, line, 0xffe08affu, 2);
    draw_text(16, 236, s->recent, 0xc8d8ffffu, 2);
    for (int i = 0; i < s->spectrum_len && i < 64; i++) {
      int h = (s->spectrum[i] * 90) / 100;
      fill_rect(16 + i * 4, 360 - h, 3, h, 0x2bd4bdffu);
    }
  } else {
    draw_text(16, 130, "ACCESS", 0x2bd4bdffu, 3);
    draw_text(16, 178, s->url, 0xffffffffu, 2);
    snprintf(line, sizeof(line), "Pairing %s", s->pairing);
    draw_text(16, 214, line, 0xffe08affu, 2);
    draw_text(16, 270, "Native LVGL skeleton", 0xa9b8c8ffu, 2);
    draw_text(16, 300, "SDL/PNG preview backend", 0xa9b8c8ffu, 2);
  }
  fill_rect(0, H - 48, W, 48, 0x142230ffu);
  draw_text(22, H - 30, "Access   Network   Monitor", 0xe8f6ffffu, 2);
}

static void json_string(const char *line, const char *key, char *out, size_t out_len) {
  char needle[64];
  snprintf(needle, sizeof(needle), "\"%s\"", key);
  const char *p = strstr(line, needle);
  if (!p) return;
  p = strchr(p + strlen(needle), ':');
  if (!p) return;
  p++;
  while (*p && isspace((unsigned char)*p)) p++;
  if (*p != '"') return;
  p++;
  size_t n = 0;
  while (*p && *p != '"' && n + 1 < out_len) out[n++] = *p++;
  out[n] = 0;
}

static int json_bool_after(const char *line, const char *key) {
  char needle[64];
  snprintf(needle, sizeof(needle), "\"%s\"", key);
  const char *p = strstr(line, needle);
  if (!p) return -1;
  p = strchr(p, ':');
  return p && strstr(p, "true") == p + 1 ? 1 : 0;
}

static void parse_spectrum(const char *line, PanelState *s) {
  const char *p = strstr(line, "\"bins\"");
  if (!p) return;
  p = strchr(p, '[');
  if (!p) return;
  p++;
  int n = 0;
  while (*p && *p != ']' && n < 64) {
    while (*p && !isdigit((unsigned char)*p) && *p != '-') p++;
    if (!*p || *p == ']') break;
    s->spectrum[n++] = atoi(p);
    while (*p && *p != ',' && *p != ']') p++;
  }
  if (n > 0) s->spectrum_len = n;
}

static void on_line(const char *line, void *user) {
  PanelState *s = (PanelState *)user;
  printf("[tx5dr-panel-lvgl] ipc <= %s\n", line);
  if (strstr(line, "\"id\"") && (strstr(line, "daemon.hello") || strstr(line, "panel.config") || strstr(line, "state.replace"))) {
    tx5dr_ipc_send_json(s->ipc_fd, "{\"v\":1,\"t\":\"renderer.applied\",\"ts\":0}");
  }
  if (strstr(line, "state.replace") || strstr(line, "state.patch")) {
    json_string(line, "screen", s->screen, sizeof(s->screen));
    json_string(line, "primary", s->network, sizeof(s->network));
    json_string(line, "ip", s->ip, sizeof(s->ip));
    json_string(line, "url", s->url, sizeof(s->url));
    json_string(line, "pairingCode", s->pairing, sizeof(s->pairing));
    json_string(line, "server", s->server, sizeof(s->server));
    json_string(line, "state", s->engine, sizeof(s->engine));
    json_string(line, "frequencyLabel", s->freq, sizeof(s->freq));
    json_string(line, "message", s->current_tx, sizeof(s->current_tx));
    int ptt = json_bool_after(line, "ptt");
    if (ptt >= 0) s->ptt = ptt;
  }
  if (strstr(line, "spectrum.update")) parse_spectrum(line, s);
}

static void write_snapshot(const Options *o) {
  const char *path = o->snapshot[0] ? o->snapshot : "/tmp/tx5dr-panel-lvgl.png";
  if (tx5dr_write_rgba_png(path, W, H, g_fb) == 0) printf("[tx5dr-panel-lvgl] wrote %s\n", path);
  else fprintf(stderr, "[tx5dr-panel-lvgl] failed to write %s\n", path);
}

#ifdef TX5DR_HAS_SDL
static void run_sdl(const Options *o, PanelState *s) {
  if (SDL_Init(SDL_INIT_VIDEO) != 0) {
    fprintf(stderr, "[tx5dr-panel-lvgl] SDL init failed, using PNG fallback: %s\n", SDL_GetError());
    render(s); write_snapshot(o); return;
  }
  SDL_Window *win = SDL_CreateWindow("TX-5DR TFT LVGL preview (skeleton)", SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED, W * o->scale, H * o->scale, 0);
  SDL_Renderer *ren = SDL_CreateRenderer(win, -1, SDL_RENDERER_ACCELERATED);
  SDL_Texture *tex = SDL_CreateTexture(ren, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_STREAMING, W, H);
  long until = now_ms() + (o->hold_ms > 0 ? o->hold_ms : o->once_ms);
  while (now_ms() < until) {
    SDL_Event e;
    while (SDL_PollEvent(&e)) {
      if (e.type == SDL_QUIT) until = 0;
      if (e.type == SDL_KEYDOWN && e.key.keysym.sym == SDLK_s) write_snapshot(o);
    }
    render(s);
    SDL_UpdateTexture(tex, NULL, g_fb, W * 4);
    SDL_RenderClear(ren); SDL_RenderCopy(ren, tex, NULL, NULL); SDL_RenderPresent(ren);
    SDL_Delay(16);
  }
  write_snapshot(o);
  SDL_DestroyTexture(tex); SDL_DestroyRenderer(ren); SDL_DestroyWindow(win); SDL_Quit();
}
#endif

int main(int argc, char **argv) {
  Options o; PanelState s; defaults(&o, &s); parse_args(argc, argv, &o);
  g_fb = (unsigned char *)calloc((size_t)W * H * 4, 1);
  if (!g_fb) return 2;
  printf("[tx5dr-panel-lvgl] backend=%s profile=%s socket=%s\n", o.backend, o.profile, o.socket_path[0] ? o.socket_path : "(none)");
  int fd = tx5dr_ipc_connect(o.socket_path);
  if (fd >= 0) {
    s.ipc_fd = fd;
    char hello[512];
    snprintf(hello, sizeof(hello), "{\"v\":1,\"t\":\"renderer.hello\",\"ts\":%ld,\"payload\":{\"renderer\":\"tx5dr-panel-lvgl\",\"backend\":\"%s\",\"profileId\":\"%s\",\"width\":320,\"height\":480,\"input\":\"touch\"}}", now_ms(), o.backend, o.profile);
    tx5dr_ipc_send_json(fd, hello);
    tx5dr_ipc_read_for(fd, o.once_ms, on_line, &s);
    close(fd);
  } else if (o.socket_path[0]) {
    fprintf(stderr, "[tx5dr-panel-lvgl] socket unavailable, rendering fallback state\n");
  }
  render(&s);
#ifdef TX5DR_HAS_SDL
  if (strcmp(o.backend, "sdl") == 0) run_sdl(&o, &s); else write_snapshot(&o);
#else
  if (strcmp(o.backend, "sdl") == 0) fprintf(stderr, "[tx5dr-panel-lvgl] SDL not compiled; PNG fallback active\n");
  write_snapshot(&o);
#endif
  free(g_fb);
  return 0;
}
