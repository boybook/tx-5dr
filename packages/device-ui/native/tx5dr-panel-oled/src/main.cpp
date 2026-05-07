#include "tx5dr_ipc.h"
#include "tx5dr_png.h"
#include <algorithm>
#include <chrono>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>
#include <vector>
#include <unistd.h>
#ifdef TX5DR_HAS_SDL
#include <SDL.h>
#endif

struct Options {
  std::string backend = "png";
  std::string profile = "oled-ssd1306-128x64-1btn";
  std::string socketPath;
  std::string snapshot = "/tmp/tx5dr-panel-oled.png";
  int scale = 6;
  int onceMs = 1200;
};

struct State {
  std::string screen = "boot";
  std::string network = "offline";
  std::string ip;
  std::string url = "tx5dr.local:8076";
  std::string pairing = "------";
  std::string server = "connecting";
  std::string engine = "unknown";
  std::string freq = "14.074";
  std::string tx = "idle";
  std::string recent = "waiting";
  bool ptt = false;
  int ipcFd = -1;
  std::vector<int> spectrum = std::vector<int>(16, 30);
};

static constexpr int W = 128;
static constexpr int H = 64;
static unsigned char mono[W * H];
static unsigned char rgba[W * H * 4];

static long now_ms() {
  auto now = std::chrono::system_clock::now().time_since_epoch();
  return std::chrono::duration_cast<std::chrono::milliseconds>(now).count();
}

static bool starts(const char *s, const char *prefix) {
  return std::strncmp(s, prefix, std::strlen(prefix)) == 0;
}

static void parseArgs(int argc, char **argv, Options &o) {
  for (int i = 1; i < argc; i++) {
    const char *a = argv[i];
    const char *eq = std::strchr(a, '=');
    if (!eq) continue;
    std::string key(a, eq - a);
    std::string val(eq + 1);
    if (key == "--backend") o.backend = val;
    else if (key == "--profile") o.profile = val;
    else if (key == "--socket") o.socketPath = val;
    else if (key == "--snapshot") o.snapshot = val;
    else if (key == "--scale") o.scale = std::max(1, std::atoi(val.c_str()));
    else if (key == "--once-ms") o.onceMs = std::max(1, std::atoi(val.c_str()));
  }
}

static void px(int x, int y, bool on = true) {
  if (x >= 0 && x < W && y >= 0 && y < H) mono[y * W + x] = on ? 1 : 0;
}

static void rect(int x, int y, int w, int h, bool on = true) {
  for (int yy = y; yy < y + h; yy++) for (int xx = x; xx < x + w; xx++) px(xx, yy, on);
}

static void glyph(int x, int y, char ch) {
  unsigned v = static_cast<unsigned char>(ch);
  for (int r = 0; r < 7; r++) {
    for (int c = 0; c < 5; c++) {
      bool edge = r == 0 || r == 6 || c == 0 || c == 4;
      bool bit = (((v >> ((r + c) % 6)) & 1u) != 0u) || (edge && ch != ' ');
      if (bit) px(x + c, y + r);
    }
  }
}

static void text(int x, int y, const std::string &s) {
  for (char ch : s) {
    if (x > W - 6) break;
    glyph(x, y, ch);
    x += 6;
  }
}

static std::string fit(std::string s, size_t n) {
  if (s.size() > n) s.resize(n);
  return s;
}

static void render(const State &s) {
  std::memset(mono, 0, sizeof(mono));
  rect(0, 0, W, 10, true);
  for (int y = 1; y < 9; y++) for (int x = 1; x < W - 1; x++) mono[y * W + x] = 0;
  text(2, 2, fit((s.ptt ? "TX " : "RX ") + s.network + " " + s.ip, 20));
  if (s.ptt || s.screen == "monitor") {
    text(0, 13, "MON " + fit(s.freq, 8) + (s.ptt ? " PTT" : ""));
    text(0, 24, fit("TX " + s.tx, 21));
    text(0, 35, fit(s.recent, 21));
    int count = std::min<int>(16, s.spectrum.size());
    for (int i = 0; i < count; i++) {
      int h = std::clamp(s.spectrum[i], 0, 100) * 16 / 100;
      rect(1 + i * 8, 63 - h, 5, h, true);
    }
  } else {
    text(0, 13, "ACCESS " + fit(s.server, 9));
    text(0, 25, fit(s.url, 21));
    text(0, 37, "PAIR " + fit(s.pairing, 6));
    text(0, 51, "OLED U8G2 SKEL");
  }
}

static void rgbaFromMono(int scale = 1) {
  (void)scale;
  for (int y = 0; y < H; y++) {
    for (int x = 0; x < W; x++) {
      bool on = mono[y * W + x] != 0;
      unsigned char *p = rgba + (y * W + x) * 4;
      p[0] = on ? 210 : 5;
      p[1] = on ? 245 : 8;
      p[2] = on ? 255 : 12;
      p[3] = 255;
    }
  }
}

static void writeSnapshot(const Options &o) {
  rgbaFromMono();
  if (tx5dr_write_rgba_png(o.snapshot.c_str(), W, H, rgba) == 0) std::printf("[tx5dr-panel-oled] wrote %s\n", o.snapshot.c_str());
  else std::fprintf(stderr, "[tx5dr-panel-oled] failed to write %s\n", o.snapshot.c_str());
}

static std::string jsonString(const char *line, const char *key, const std::string &fallback) {
  std::string needle = std::string("\"") + key + "\"";
  const char *p = std::strstr(line, needle.c_str());
  if (!p) return fallback;
  p = std::strchr(p + needle.size(), ':');
  if (!p) return fallback;
  p++;
  while (*p && std::isspace(static_cast<unsigned char>(*p))) p++;
  if (*p != '"') return fallback;
  p++;
  std::string out;
  while (*p && *p != '"' && out.size() < 160) out.push_back(*p++);
  return out.empty() ? fallback : out;
}

static int jsonBool(const char *line, const char *key) {
  std::string needle = std::string("\"") + key + "\"";
  const char *p = std::strstr(line, needle.c_str());
  if (!p) return -1;
  p = std::strchr(p, ':');
  if (!p) return -1;
  p++;
  while (*p && std::isspace(static_cast<unsigned char>(*p))) p++;
  return starts(p, "true") ? 1 : 0;
}

static void parseSpectrum(const char *line, State &s) {
  const char *p = std::strstr(line, "\"bins\"");
  if (!p) return;
  p = std::strchr(p, '[');
  if (!p) return;
  p++;
  std::vector<int> bins;
  while (*p && *p != ']' && bins.size() < 16) {
    while (*p && !std::isdigit(static_cast<unsigned char>(*p)) && *p != '-') p++;
    if (!*p || *p == ']') break;
    bins.push_back(std::atoi(p));
    while (*p && *p != ',' && *p != ']') p++;
  }
  if (!bins.empty()) s.spectrum = bins;
}

static void onLine(const char *line, void *user) {
  auto *s = static_cast<State *>(user);
  std::printf("[tx5dr-panel-oled] ipc <= %s\n", line);
  if (std::strstr(line, "daemon.hello") || std::strstr(line, "panel.config") || std::strstr(line, "state.replace")) {
    tx5dr_ipc_send_json(s->ipcFd, "{\"v\":1,\"t\":\"renderer.applied\",\"ts\":0}");
  }
  if (std::strstr(line, "state.replace") || std::strstr(line, "state.patch")) {
    s->screen = jsonString(line, "screen", s->screen);
    s->network = jsonString(line, "primary", s->network);
    s->ip = jsonString(line, "ip", s->ip);
    s->url = jsonString(line, "url", s->url);
    s->pairing = jsonString(line, "pairingCode", s->pairing);
    s->server = jsonString(line, "server", s->server);
    s->engine = jsonString(line, "state", s->engine);
    s->freq = jsonString(line, "frequencyLabel", s->freq);
    s->tx = jsonString(line, "message", s->tx);
    int ptt = jsonBool(line, "ptt");
    if (ptt >= 0) s->ptt = ptt == 1;
  }
  if (std::strstr(line, "spectrum.update")) parseSpectrum(line, *s);
}

#ifdef TX5DR_HAS_SDL
static void runSdl(const Options &o, State &s) {
  if (SDL_Init(SDL_INIT_VIDEO) != 0) {
    std::fprintf(stderr, "[tx5dr-panel-oled] SDL init failed, using PNG fallback: %s\n", SDL_GetError());
    writeSnapshot(o); return;
  }
  SDL_Window *win = SDL_CreateWindow("TX-5DR OLED preview (skeleton)", SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED, W * o.scale, H * o.scale, 0);
  SDL_Renderer *ren = SDL_CreateRenderer(win, -1, SDL_RENDERER_ACCELERATED);
  SDL_Texture *tex = SDL_CreateTexture(ren, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_STREAMING, W, H);
  long until = now_ms() + o.onceMs;
  while (now_ms() < until) {
    SDL_Event e;
    while (SDL_PollEvent(&e)) {
      if (e.type == SDL_QUIT) until = 0;
      if (e.type == SDL_KEYDOWN && e.key.keysym.sym == SDLK_s) writeSnapshot(o);
    }
    render(s); rgbaFromMono();
    SDL_UpdateTexture(tex, nullptr, rgba, W * 4);
    SDL_RenderClear(ren); SDL_RenderCopy(ren, tex, nullptr, nullptr); SDL_RenderPresent(ren);
    SDL_Delay(16);
  }
  writeSnapshot(o);
  SDL_DestroyTexture(tex); SDL_DestroyRenderer(ren); SDL_DestroyWindow(win); SDL_Quit();
}
#endif

int main(int argc, char **argv) {
  Options o; State s; parseArgs(argc, argv, o);
  std::printf("[tx5dr-panel-oled] backend=%s profile=%s socket=%s\n", o.backend.c_str(), o.profile.c_str(), o.socketPath.empty() ? "(none)" : o.socketPath.c_str());
  int fd = tx5dr_ipc_connect(o.socketPath.c_str());
  if (fd >= 0) {
    s.ipcFd = fd;
    char hello[640];
    std::snprintf(hello, sizeof(hello), "{\"v\":1,\"t\":\"renderer.hello\",\"ts\":%ld,\"payload\":{\"renderer\":\"tx5dr-panel-oled\",\"backend\":\"%s\",\"profileId\":\"%s\",\"width\":128,\"height\":64,\"input\":\"1-button\"}}", now_ms(), o.backend.c_str(), o.profile.c_str());
    tx5dr_ipc_send_json(fd, hello);
    tx5dr_ipc_read_for(fd, o.onceMs, onLine, &s);
    close(fd);
  } else if (!o.socketPath.empty()) {
    std::fprintf(stderr, "[tx5dr-panel-oled] socket unavailable, rendering fallback state\n");
  }
  render(s);
#ifdef TX5DR_HAS_SDL
  if (o.backend == "sdl") runSdl(o, s); else writeSnapshot(o);
#else
  if (o.backend == "sdl") std::fprintf(stderr, "[tx5dr-panel-oled] SDL not compiled; PNG fallback active\n");
  writeSnapshot(o);
#endif
  return 0;
}
