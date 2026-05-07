#define _POSIX_C_SOURCE 200809L
#include "lvgl.h"
#include "tx5dr_ipc.h"
#include "tx5dr_png.h"
#include "yyjson.h"

#include <errno.h>
#include <ctype.h>
#include <dirent.h>
#include <fcntl.h>
#include <poll.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <sys/time.h>
#include <unistd.h>

#if LV_USE_SDL
#include "src/drivers/sdl/lv_sdl_keyboard.h"
#include "src/drivers/sdl/lv_sdl_mouse.h"
#include "src/drivers/sdl/lv_sdl_window.h"
#endif
#if LV_USE_LINUX_FBDEV
#include "src/drivers/display/fb/lv_linux_fbdev.h"
#endif
#if LV_USE_EVDEV
#include "src/drivers/evdev/lv_evdev.h"
#endif

#define TFT_W 320
#define TFT_H 480
#define IPC_BUF_MAX TX5DR_IPC_MAX_LINE
#define RECENT_MAX 5
#define WIFI_MAX 8
#define BARS 64
#define DEFAULT_INPUT_PATH "/dev/input/by-path/platform-fe204000.spi-cs-1-event"

typedef struct {
  char backend[16];
  char profile[64];
  char socket_path[256];
  char fb_path[128];
  char input_path[192];
  char calibration_path[256];
  char snapshot[256];
  int scale;
  int once_ms;
  int hold_ms;
} Options;

typedef struct {
  int raw_min_x;
  int raw_max_x;
  int raw_min_y;
  int raw_max_y;
  bool swap_xy;
  bool invert_x;
  bool invert_y;
  int rotation;
} Calibration;

typedef struct {
  char ssid[96];
  int signal;
  char security[64];
} WifiItem;

typedef struct {
  char screen[32];
  char network_primary[32];
  char network_label[96];
  char ip[64];
  char ethernet_ip[64];
  char wifi_ssid[96];
  char wifi_state[32];
  char hotspot_ssid[96];
  char hotspot_password[64];
  char hotspot_ip[64];
  bool hotspot_active;
  bool wifi_supported;
  WifiItem wifi[WIFI_MAX];
  int wifi_count;

  char url[160];
  char pairing_code[32];
  char pairing_url[192];
  int browser_count;

  char server[32];
  char engine_state[32];
  char mode[32];
  char frequency[64];
  char band[32];
  char tx_message[160];
  char tx_callsign[32];
  bool ptt;
  bool radio_connected;
  int slot_ms;

  char recent[RECENT_MAX][160];
  int recent_count;
  int spectrum[BARS];
  int spectrum_len;
  char warning[128];
  bool touch_available;
  char renderer_error[160];
} PanelState;

typedef struct {
  Options opt;
  Calibration cal;
  PanelState state;
  int ipc_fd;
  char ipc_buf[IPC_BUF_MAX + 1];
  size_t ipc_used;
  long next_reconnect_ms;
  long started_ms;
  lv_display_t *display;
  lv_obj_t *root;
  lv_obj_t *toast;
  uint8_t *png_fb;
  uint8_t *png_draw;
} App;

static App g;

static long now_ms(void) {
  struct timeval tv;
  gettimeofday(&tv, NULL);
  return (long)tv.tv_sec * 1000L + (long)tv.tv_usec / 1000L;
}

static uint32_t lv_tick_cb(void) { return (uint32_t)now_ms(); }

static void sleep_ms(int ms) {
  struct timespec ts;
  ts.tv_sec = ms / 1000;
  ts.tv_nsec = (long)(ms % 1000) * 1000000L;
  nanosleep(&ts, NULL);
}

static const char *arg_value(const char *arg, const char *name) {
  size_t n = strlen(name);
  return strncmp(arg, name, n) == 0 && arg[n] == '=' ? arg + n + 1 : NULL;
}

static void set_str(char *dst, size_t n, const char *src) {
  if(!dst || n == 0) return;
  if(!src) src = "";
  snprintf(dst, n, "%s", src);
}

static void defaults(App *app) {
  memset(app, 0, sizeof(*app));
  set_str(app->opt.backend, sizeof(app->opt.backend), "png");
  set_str(app->opt.profile, sizeof(app->opt.profile), "tft-ili9486-320x480-touch");
  set_str(app->opt.fb_path, sizeof(app->opt.fb_path), "/dev/fb1");
  set_str(app->opt.input_path, sizeof(app->opt.input_path), DEFAULT_INPUT_PATH);
  set_str(app->opt.calibration_path, sizeof(app->opt.calibration_path), "/var/lib/tx5dr/device-ui/calibration.json");
  app->opt.scale = 2;
  app->opt.once_ms = 1200;
  app->opt.hold_ms = 600000;

  app->cal.raw_min_x = 268;
  app->cal.raw_max_x = 3880;
  app->cal.raw_min_y = 227;
  app->cal.raw_max_y = 3936;
  app->cal.swap_xy = false;
  app->cal.invert_x = false;
  app->cal.invert_y = false;
  app->cal.rotation = 0;

  PanelState *s = &app->state;
  set_str(s->screen, sizeof(s->screen), "boot");
  set_str(s->network_primary, sizeof(s->network_primary), "offline");
  set_str(s->network_label, sizeof(s->network_label), "Offline");
  set_str(s->url, sizeof(s->url), "http://tx5dr.local:8076");
  set_str(s->pairing_code, sizeof(s->pairing_code), "------");
  set_str(s->server, sizeof(s->server), "connecting");
  set_str(s->engine_state, sizeof(s->engine_state), "unknown");
  set_str(s->mode, sizeof(s->mode), "FT8");
  set_str(s->frequency, sizeof(s->frequency), "--");
  set_str(s->band, sizeof(s->band), "--");
  s->slot_ms = -1;
  s->touch_available = true;
  s->spectrum_len = BARS;
  for(int i = 0; i < BARS; i++) s->spectrum[i] = (i * 23) % 100;
}

static void parse_args(int argc, char **argv, Options *o) {
  const char *env;
  if((env = getenv("TX5DR_DEVICE_UI_FB"))) set_str(o->fb_path, sizeof(o->fb_path), env);
  if((env = getenv("TX5DR_DEVICE_UI_INPUT"))) set_str(o->input_path, sizeof(o->input_path), env);
  if((env = getenv("TX5DR_DEVICE_UI_CALIBRATION"))) set_str(o->calibration_path, sizeof(o->calibration_path), env);
  if((env = getenv("TX5DR_DEVICE_UI_SOCKET"))) set_str(o->socket_path, sizeof(o->socket_path), env);
  for(int i = 1; i < argc; i++) {
    const char *v;
    if((v = arg_value(argv[i], "--backend"))) set_str(o->backend, sizeof(o->backend), v);
    else if((v = arg_value(argv[i], "--profile"))) set_str(o->profile, sizeof(o->profile), v);
    else if((v = arg_value(argv[i], "--socket"))) set_str(o->socket_path, sizeof(o->socket_path), v);
    else if((v = arg_value(argv[i], "--fb"))) set_str(o->fb_path, sizeof(o->fb_path), v);
    else if((v = arg_value(argv[i], "--input"))) set_str(o->input_path, sizeof(o->input_path), v);
    else if((v = arg_value(argv[i], "--calibration"))) set_str(o->calibration_path, sizeof(o->calibration_path), v);
    else if((v = arg_value(argv[i], "--snapshot"))) set_str(o->snapshot, sizeof(o->snapshot), v);
    else if((v = arg_value(argv[i], "--scale"))) o->scale = atoi(v) > 0 ? atoi(v) : 2;
    else if((v = arg_value(argv[i], "--once-ms"))) o->once_ms = atoi(v) > 0 ? atoi(v) : 1200;
    else if((v = arg_value(argv[i], "--hold-ms"))) o->hold_ms = atoi(v) > 0 ? atoi(v) : 600000;
  }
}

static yyjson_val *obj_get(yyjson_val *obj, const char *key) {
  return obj && yyjson_is_obj(obj) ? yyjson_obj_get(obj, key) : NULL;
}

static yyjson_val *path_get(yyjson_val *obj, const char *a, const char *b) {
  return obj_get(obj_get(obj, a), b);
}

static void json_copy(yyjson_val *obj, const char *key, char *dst, size_t n) {
  yyjson_val *v = obj_get(obj, key);
  if(v && yyjson_is_str(v)) set_str(dst, n, yyjson_get_str(v));
}

static void json_copy_path(yyjson_val *obj, const char *a, const char *b, char *dst, size_t n) {
  yyjson_val *v = path_get(obj, a, b);
  if(v && yyjson_is_str(v)) set_str(dst, n, yyjson_get_str(v));
}

static int json_int(yyjson_val *obj, const char *key, int fallback) {
  yyjson_val *v = obj_get(obj, key);
  return v && yyjson_is_num(v) ? (int)yyjson_get_int(v) : fallback;
}

static bool json_bool(yyjson_val *obj, const char *key, bool fallback) {
  yyjson_val *v = obj_get(obj, key);
  return v && yyjson_is_bool(v) ? yyjson_get_bool(v) : fallback;
}

static void load_calibration(App *app) {
  FILE *f = fopen(app->opt.calibration_path, "rb");
  if(!f) return;
  fseek(f, 0, SEEK_END);
  long len = ftell(f);
  rewind(f);
  if(len <= 0 || len > 4096) { fclose(f); return; }
  char *buf = malloc((size_t)len + 1);
  if(!buf) { fclose(f); return; }
  if(fread(buf, 1, (size_t)len, f) != (size_t)len) { free(buf); fclose(f); return; }
  buf[len] = 0;
  fclose(f);
  yyjson_doc *doc = yyjson_read(buf, (size_t)len, 0);
  free(buf);
  if(!doc) return;
  yyjson_val *r = yyjson_doc_get_root(doc);
  app->cal.raw_min_x = json_int(r, "rawMinX", app->cal.raw_min_x);
  app->cal.raw_max_x = json_int(r, "rawMaxX", app->cal.raw_max_x);
  app->cal.raw_min_y = json_int(r, "rawMinY", app->cal.raw_min_y);
  app->cal.raw_max_y = json_int(r, "rawMaxY", app->cal.raw_max_y);
  app->cal.swap_xy = json_bool(r, "swapXY", app->cal.swap_xy);
  app->cal.invert_x = json_bool(r, "invertX", app->cal.invert_x);
  app->cal.invert_y = json_bool(r, "invertY", app->cal.invert_y);
  app->cal.rotation = json_int(r, "rotation", app->cal.rotation);
  if(app->cal.rotation != 0) {
    fprintf(stderr, "[tx5dr-panel-lvgl] touch calibration rotation=%d is not supported in this TFT profile; use display overlay rotation=0 and calibration rotation=0.\n", app->cal.rotation);
    app->cal.rotation = 0;
  }
  yyjson_doc_free(doc);
}

static void ipc_send_raw(const char *json) {
  if(g.ipc_fd >= 0) tx5dr_ipc_send_json(g.ipc_fd, json);
}

static void ipc_send_ack(const char *id, const char *applied) {
  char out[512];
  if(id && id[0]) snprintf(out, sizeof(out), "{\"v\":1,\"id\":\"%s\",\"t\":\"renderer.applied\",\"ts\":%ld,\"payload\":{\"applied\":\"%s\"}}", id, now_ms(), applied ? applied : "message");
  else snprintf(out, sizeof(out), "{\"v\":1,\"t\":\"renderer.applied\",\"ts\":%ld,\"payload\":{\"applied\":\"%s\"}}", now_ms(), applied ? applied : "message");
  ipc_send_raw(out);
}

static void ipc_send_action(const char *action) {
  char out[512];
  snprintf(out, sizeof(out), "{\"v\":1,\"t\":\"ui.action\",\"ts\":%ld,\"payload\":{\"action\":\"%s\",\"source\":\"touch\",\"screen\":\"%s\"}}", now_ms(), action, g.state.screen);
  ipc_send_raw(out);
}

static void ipc_send_hello(void) {
  char out[768];
  snprintf(out, sizeof(out), "{\"v\":1,\"t\":\"renderer.hello\",\"ts\":%ld,\"payload\":{\"renderer\":\"tx5dr-panel-lvgl\",\"backend\":\"%s\",\"profileId\":\"%s\",\"width\":320,\"height\":480,\"input\":\"%s\"}}", now_ms(), g.opt.backend, g.opt.profile, g.state.touch_available ? "touch" : "none");
  ipc_send_raw(out);
}

static lv_obj_t *label(lv_obj_t *parent, const char *txt, int x, int y, const lv_font_t *font, uint32_t color) {
  lv_obj_t *l = lv_label_create(parent);
  lv_label_set_text(l, txt ? txt : "");
  lv_obj_set_style_text_font(l, font, 0);
  lv_obj_set_style_text_color(l, lv_color_hex(color), 0);
  lv_obj_set_pos(l, x, y);
  return l;
}

static lv_obj_t *panel(lv_obj_t *parent, int x, int y, int w, int h, uint32_t bg) {
  lv_obj_t *o = lv_obj_create(parent);
  lv_obj_set_pos(o, x, y);
  lv_obj_set_size(o, w, h);
  lv_obj_set_style_bg_color(o, lv_color_hex(bg), 0);
  lv_obj_set_style_bg_opa(o, LV_OPA_COVER, 0);
  lv_obj_set_style_border_color(o, lv_color_hex(0x28465a), 0);
  lv_obj_set_style_border_width(o, 1, 0);
  lv_obj_set_style_radius(o, 10, 0);
  lv_obj_set_style_pad_all(o, 8, 0);
  return o;
}

static void event_action(lv_event_t *e) {
  const char *action = (const char *)lv_event_get_user_data(e);
  if(action) ipc_send_action(action);
}

static lv_obj_t *button(lv_obj_t *parent, const char *txt, int x, int y, int w, int h, const char *action) {
  lv_obj_t *b = lv_button_create(parent);
  lv_obj_set_pos(b, x, y);
  lv_obj_set_size(b, w, h);
  lv_obj_set_style_bg_color(b, lv_color_hex(0x1b5f77), 0);
  lv_obj_set_style_radius(b, 8, 0);
  lv_obj_add_event_cb(b, event_action, LV_EVENT_CLICKED, (void *)action);
  lv_obj_t *l = lv_label_create(b);
  lv_label_set_text(l, txt);
  lv_obj_set_style_text_font(l, &lv_font_montserrat_14, 0);
  lv_obj_center(l);
  return b;
}

static void draw_status(lv_obj_t *root) {
  PanelState *s = &g.state;
  lv_obj_t *bar = lv_obj_create(root);
  lv_obj_set_pos(bar, 0, 0);
  lv_obj_set_size(bar, TFT_W, 34);
  lv_obj_set_style_bg_color(bar, lv_color_hex(s->ptt ? 0x9f2525 : 0x12384c), 0);
  lv_obj_set_style_radius(bar, 0, 0);
  lv_obj_set_style_border_width(bar, 0, 0);
  lv_obj_set_style_pad_all(bar, 0, 0);
  char line[192];
  snprintf(line, sizeof(line), "%s %s", s->network_label[0] ? s->network_label : s->network_primary, s->ip);
  label(bar, line, 8, 8, &lv_font_montserrat_12, 0xe8f6ff);
  snprintf(line, sizeof(line), "%s %s %s", s->server, s->engine_state, s->ptt ? "PTT" : "RX");
  lv_obj_t *right = label(bar, line, 190, 8, &lv_font_montserrat_12, 0xe8f6ff);
  lv_label_set_long_mode(right, LV_LABEL_LONG_CLIP);
  lv_obj_set_width(right, 122);
  lv_obj_t *accent = lv_obj_create(root);
  lv_obj_set_pos(accent, 0, 34);
  lv_obj_set_size(accent, TFT_W, 3);
  lv_obj_set_style_bg_color(accent, lv_color_hex(0x2bd4bd), 0);
  lv_obj_set_style_border_width(accent, 0, 0);
  lv_obj_set_style_radius(accent, 0, 0);
}

static void draw_tabs(lv_obj_t *root) {
  lv_obj_t *bar = lv_obj_create(root);
  lv_obj_set_pos(bar, 0, TFT_H - 50);
  lv_obj_set_size(bar, TFT_W, 50);
  lv_obj_set_style_bg_color(bar, lv_color_hex(0x101c28), 0);
  lv_obj_set_style_border_width(bar, 0, 0);
  lv_obj_set_style_radius(bar, 0, 0);
  button(bar, "Access", 8, 7, 96, 36, "nav.access");
  button(bar, "Network", 112, 7, 96, 36, "nav.network");
  button(bar, "Monitor", 216, 7, 96, 36, "nav.monitor");
}

static void draw_access(lv_obj_t *root) {
  PanelState *s = &g.state;
  label(root, "Access", 14, 50, &lv_font_montserrat_24, 0x2bd4bd);
  lv_obj_t *card = panel(root, 14, 88, 292, 250, 0x162536);
#if LV_USE_QRCODE
  const char *qr_text = s->pairing_url[0] ? s->pairing_url : s->url;
  if(qr_text && qr_text[0]) {
    lv_obj_t *qr = lv_qrcode_create(card);
    lv_qrcode_set_size(qr, 132);
    lv_qrcode_set_dark_color(qr, lv_color_hex(0x0c1018));
    lv_qrcode_set_light_color(qr, lv_color_hex(0xf3fbff));
    lv_qrcode_update(qr, qr_text, strlen(qr_text));
    lv_obj_set_pos(qr, 72, 4);
  }
#endif
  lv_obj_t *url = label(card, s->url[0] ? s->url : "No access URL", 4, 150, &lv_font_montserrat_14, 0xffffff);
  lv_label_set_long_mode(url, LV_LABEL_LONG_DOT);
  lv_obj_set_width(url, 270);
  char line[96];
  snprintf(line, sizeof(line), "Pairing: %s", s->pairing_code[0] ? s->pairing_code : "------");
  label(card, line, 4, 180, &lv_font_montserrat_18, 0xffdf8a);
  snprintf(line, sizeof(line), "Browsers: %d", s->browser_count);
  label(card, line, 4, 214, &lv_font_montserrat_12, 0xa9b8c8);
  button(root, "Refresh Pair", 14, 352, 138, 42, "access.refresh-pairing-code");
  button(root, "Diagnostics", 168, 352, 138, 42, "system.show-diagnostics");
  if(strcmp(s->server, "ready") != 0) label(root, "Server offline: local network info is still shown.", 14, 410, &lv_font_montserrat_12, 0xffbf70);
}

static void draw_network(lv_obj_t *root) {
  PanelState *s = &g.state;
  label(root, "Network", 14, 50, &lv_font_montserrat_24, 0x2bd4bd);
  lv_obj_t *eth = panel(root, 14, 88, 292, 64, 0x162536);
  char line[192];
  snprintf(line, sizeof(line), "Ethernet  %s", s->ethernet_ip[0] ? s->ethernet_ip : "not connected");
  label(eth, line, 4, 8, &lv_font_montserrat_14, 0xffffff);
  snprintf(line, sizeof(line), "Wi-Fi  %s %s", s->wifi_state[0] ? s->wifi_state : "unknown", s->wifi_ssid);
  lv_obj_t *wifi = panel(root, 14, 160, 292, 118, 0x162536);
  label(wifi, line, 4, 4, &lv_font_montserrat_14, 0xffffff);
  int max = s->wifi_count < 3 ? s->wifi_count : 3;
  for(int i = 0; i < max; i++) {
    snprintf(line, sizeof(line), "%d. %s  %d%%", i + 1, s->wifi[i].ssid, s->wifi[i].signal);
    label(wifi, line, 4, 30 + i * 24, &lv_font_montserrat_12, 0xc8d8ff);
  }
  button(root, "Scan Wi-Fi", 14, 292, 138, 40, "network.scan");
  button(root, s->hotspot_active ? "Stop Hotspot" : "Start Hotspot", 168, 292, 138, 40, s->hotspot_active ? "network.hotspot.stop" : "network.hotspot.start");
  lv_obj_t *hotspot = panel(root, 14, 344, 292, 72, 0x162536);
  snprintf(line, sizeof(line), "Hotspot %s", s->hotspot_active ? "ON" : "off");
  label(hotspot, line, 4, 4, &lv_font_montserrat_14, s->hotspot_active ? 0x2bd4bd : 0xa9b8c8);
  snprintf(line, sizeof(line), "%s  %s", s->hotspot_ssid, s->hotspot_ip);
  lv_obj_t *h = label(hotspot, line, 4, 32, &lv_font_montserrat_12, 0xffffff);
  lv_label_set_long_mode(h, LV_LABEL_LONG_DOT);
  lv_obj_set_width(h, 260);
}

static void draw_monitor(lv_obj_t *root) {
  PanelState *s = &g.state;
  label(root, "Monitor", 14, 50, &lv_font_montserrat_24, 0x2bd4bd);
  lv_obj_t *card = panel(root, 14, 86, 292, 108, 0x162536);
  char line[192];
  snprintf(line, sizeof(line), "%s  %s  %s", s->frequency, s->mode, s->band);
  label(card, line, 4, 4, &lv_font_montserrat_18, 0xffffff);
  snprintf(line, sizeof(line), "Radio %s  PTT %s  Slot %0.1fs", s->radio_connected ? "ready" : "off", s->ptt ? "ON" : "off", s->slot_ms >= 0 ? s->slot_ms / 1000.0 : 0.0);
  label(card, line, 4, 36, &lv_font_montserrat_12, s->ptt ? 0xffb3a0 : 0xc8d8ff);
  lv_obj_t *tx = label(card, s->tx_message[0] ? s->tx_message : "TX idle", 4, 66, &lv_font_montserrat_14, 0xffdf8a);
  lv_label_set_long_mode(tx, LV_LABEL_LONG_DOT);
  lv_obj_set_width(tx, 260);

  lv_obj_t *spec = panel(root, 14, 206, 292, 98, 0x0e1824);
  for(int i = 0; i < BARS; i++) {
    int v = i < s->spectrum_len ? s->spectrum[i] : 0;
    if(v < 0) v = 0; if(v > 100) v = 100;
    lv_obj_t *bar = lv_obj_create(spec);
    int bh = (v * 72) / 100;
    lv_obj_set_size(bar, 3, bh < 2 ? 2 : bh);
    lv_obj_set_pos(bar, 4 + i * 4, 78 - bh);
    lv_obj_set_style_bg_color(bar, lv_color_hex(s->ptt ? 0xff5f5f : 0x2bd4bd), 0);
    lv_obj_set_style_border_width(bar, 0, 0);
    lv_obj_set_style_radius(bar, 1, 0);
  }

  lv_obj_t *msgs = panel(root, 14, 316, 292, 104, 0x162536);
  label(msgs, "Recent", 4, 0, &lv_font_montserrat_12, 0xa9b8c8);
  int n = s->recent_count < RECENT_MAX ? s->recent_count : RECENT_MAX;
  for(int i = 0; i < n; i++) {
    lv_obj_t *m = label(msgs, s->recent[i], 4, 20 + i * 16, &lv_font_montserrat_10, 0xffffff);
    lv_label_set_long_mode(m, LV_LABEL_LONG_DOT);
    lv_obj_set_width(m, 260);
  }
}

static void draw_diagnostics(lv_obj_t *root) {
  PanelState *s = &g.state;
  label(root, "Diagnostics", 14, 50, &lv_font_montserrat_24, 0x2bd4bd);
  lv_obj_t *card = panel(root, 14, 90, 292, 260, 0x162536);
  char line[256];
  snprintf(line, sizeof(line), "Backend: %s", g.opt.backend); label(card, line, 4, 4, &lv_font_montserrat_12, 0xffffff);
  snprintf(line, sizeof(line), "FB: %s", g.opt.fb_path); label(card, line, 4, 30, &lv_font_montserrat_12, 0xffffff);
  snprintf(line, sizeof(line), "Input: %s", s->touch_available ? g.opt.input_path : "unavailable");
  lv_obj_t *inp = label(card, line, 4, 56, &lv_font_montserrat_12, s->touch_available ? 0xffffff : 0xff7676);
  lv_label_set_long_mode(inp, LV_LABEL_LONG_DOT); lv_obj_set_width(inp, 260);
  snprintf(line, sizeof(line), "Cal: %d,%d %d,%d swap=%d", g.cal.raw_min_x, g.cal.raw_max_x, g.cal.raw_min_y, g.cal.raw_max_y, g.cal.swap_xy);
  label(card, line, 4, 88, &lv_font_montserrat_12, 0xc8d8ff);
  snprintf(line, sizeof(line), "IPC: %s", g.ipc_fd >= 0 ? "connected" : "offline"); label(card, line, 4, 118, &lv_font_montserrat_12, 0xc8d8ff);
  if(s->renderer_error[0]) {
    lv_obj_t *err = label(card, s->renderer_error, 4, 150, &lv_font_montserrat_12, 0xff7676);
    lv_label_set_long_mode(err, LV_LABEL_LONG_WRAP); lv_obj_set_width(err, 260);
  }
  button(root, "Restart Renderer", 14, 370, 140, 42, "system.restart-renderer");
  button(root, "Back Access", 166, 370, 140, 42, "nav.access");
}

static void build_ui(void) {
  lv_obj_t *scr = lv_screen_active();
  lv_obj_clean(scr);
  lv_obj_set_style_bg_color(scr, lv_color_hex(0x0c121a), 0);
  lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, 0);
  draw_status(scr);
  if(strcmp(g.state.screen, "network-overview") == 0 || strcmp(g.state.screen, "wifi-scan") == 0 || strcmp(g.state.screen, "hotspot") == 0) draw_network(scr);
  else if(strcmp(g.state.screen, "monitor") == 0) draw_monitor(scr);
  else if(strcmp(g.state.screen, "diagnostics") == 0) draw_diagnostics(scr);
  else draw_access(scr);
  draw_tabs(scr);
  if(!g.state.touch_available && strcmp(g.state.screen, "diagnostics") != 0) {
    label(scr, "Touch unavailable", 14, 420, &lv_font_montserrat_12, 0xff7676);
  }
  lv_obj_invalidate(scr);
}

static void parse_network(yyjson_val *network) {
  if(!network) return;
  PanelState *s = &g.state;
  json_copy(network, "primary", s->network_primary, sizeof(s->network_primary));
  json_copy_path(network, "ethernet", "ip", s->ethernet_ip, sizeof(s->ethernet_ip));
  json_copy_path(network, "wifi", "ssid", s->wifi_ssid, sizeof(s->wifi_ssid));
  json_copy_path(network, "wifi", "state", s->wifi_state, sizeof(s->wifi_state));
  yyjson_val *wifi = obj_get(network, "wifi");
  if(wifi) s->wifi_supported = json_bool(wifi, "supported", s->wifi_supported);
  json_copy_path(network, "hotspot", "ssid", s->hotspot_ssid, sizeof(s->hotspot_ssid));
  json_copy_path(network, "hotspot", "password", s->hotspot_password, sizeof(s->hotspot_password));
  json_copy_path(network, "hotspot", "ip", s->hotspot_ip, sizeof(s->hotspot_ip));
  yyjson_val *hotspot = obj_get(network, "hotspot");
  if(hotspot) s->hotspot_active = json_bool(hotspot, "active", s->hotspot_active);
  if(strcmp(s->network_primary, "ethernet") == 0) { set_str(s->network_label, sizeof(s->network_label), "Ethernet"); set_str(s->ip, sizeof(s->ip), s->ethernet_ip); }
  else if(strcmp(s->network_primary, "wifi") == 0) { set_str(s->network_label, sizeof(s->network_label), s->wifi_ssid[0] ? s->wifi_ssid : "Wi-Fi"); json_copy_path(network, "wifi", "ip", s->ip, sizeof(s->ip)); }
  else if(strcmp(s->network_primary, "hotspot") == 0) { set_str(s->network_label, sizeof(s->network_label), s->hotspot_ssid[0] ? s->hotspot_ssid : "Hotspot"); set_str(s->ip, sizeof(s->ip), s->hotspot_ip); }
  else { set_str(s->network_label, sizeof(s->network_label), "Offline"); set_str(s->ip, sizeof(s->ip), ""); }

  yyjson_val *scan = path_get(network, "wifi", "scanResults");
  if(scan && yyjson_is_arr(scan)) {
    s->wifi_count = 0;
    size_t idx, max; yyjson_val *item;
    yyjson_arr_foreach(scan, idx, max, item) {
      if(s->wifi_count >= WIFI_MAX) break;
      json_copy(item, "ssid", s->wifi[s->wifi_count].ssid, sizeof(s->wifi[s->wifi_count].ssid));
      s->wifi[s->wifi_count].signal = json_int(item, "signalPercent", 0);
      yyjson_val *sec = obj_get(item, "security");
      if(sec && yyjson_is_arr(sec)) {
        yyjson_val *first = yyjson_arr_get_first(sec);
        if(first && yyjson_is_str(first)) set_str(s->wifi[s->wifi_count].security, sizeof(s->wifi[s->wifi_count].security), yyjson_get_str(first));
      }
      if(s->wifi[s->wifi_count].ssid[0]) s->wifi_count++;
    }
  }
}

static void parse_access(yyjson_val *access) {
  if(!access) return;
  PanelState *s = &g.state;
  json_copy(access, "url", s->url, sizeof(s->url));
  json_copy(access, "pairingCode", s->pairing_code, sizeof(s->pairing_code));
  json_copy(access, "pairingUrl", s->pairing_url, sizeof(s->pairing_url));
  s->browser_count = json_int(access, "browserClientCount", s->browser_count);
}

static void parse_tx5dr(yyjson_val *tx5dr) {
  if(!tx5dr) return;
  PanelState *s = &g.state;
  json_copy(tx5dr, "server", s->server, sizeof(s->server));
  yyjson_val *engine = obj_get(tx5dr, "engine");
  if(engine) {
    json_copy(engine, "state", s->engine_state, sizeof(s->engine_state));
    json_copy(engine, "mode", s->mode, sizeof(s->mode));
    s->slot_ms = json_int(engine, "nextSlotInMs", s->slot_ms);
  }
  yyjson_val *radio = obj_get(tx5dr, "radio");
  if(radio) {
    s->radio_connected = json_bool(radio, "connected", s->radio_connected);
    s->ptt = json_bool(radio, "ptt", s->ptt);
    json_copy(radio, "frequencyLabel", s->frequency, sizeof(s->frequency));
    json_copy(radio, "band", s->band, sizeof(s->band));
  }
}

static void parse_monitor(yyjson_val *monitor) {
  if(!monitor) return;
  PanelState *s = &g.state;
  yyjson_val *current = obj_get(monitor, "currentTx");
  if(current) {
    json_copy(current, "message", s->tx_message, sizeof(s->tx_message));
    json_copy(current, "callsign", s->tx_callsign, sizeof(s->tx_callsign));
  } else set_str(s->tx_message, sizeof(s->tx_message), "");
  yyjson_val *spec = obj_get(monitor, "spectrum");
  yyjson_val *bins = obj_get(spec, "bins");
  if(bins && yyjson_is_arr(bins)) {
    s->spectrum_len = 0;
    size_t idx, max; yyjson_val *v;
    yyjson_arr_foreach(bins, idx, max, v) {
      if(s->spectrum_len >= BARS) break;
      int val = yyjson_is_num(v) ? (int)yyjson_get_int(v) : 0;
      if(val <= 1 && yyjson_is_num(v)) val = (int)(yyjson_get_real(v) * 100.0);
      s->spectrum[s->spectrum_len++] = val;
    }
  }
  yyjson_val *recent = obj_get(monitor, "recentMessages");
  if(recent && yyjson_is_arr(recent)) {
    s->recent_count = 0;
    size_t idx, max; yyjson_val *item;
    yyjson_arr_foreach(recent, idx, max, item) {
      if(s->recent_count >= RECENT_MAX) break;
      const char *dir = ""; yyjson_val *d = obj_get(item, "direction"); if(d && yyjson_is_str(d)) dir = yyjson_get_str(d);
      const char *msg = ""; yyjson_val *m = obj_get(item, "message"); if(m && yyjson_is_str(m)) msg = yyjson_get_str(m);
      const char *call = ""; yyjson_val *c = obj_get(item, "callsign"); if(c && yyjson_is_str(c)) call = yyjson_get_str(c);
      int snr = json_int(item, "snr", 999);
      if(snr != 999) snprintf(s->recent[s->recent_count], sizeof(s->recent[s->recent_count]), "%s %s %s %ddB", dir, call, msg, snr);
      else snprintf(s->recent[s->recent_count], sizeof(s->recent[s->recent_count]), "%s %s %s", dir, call, msg);
      s->recent_count++;
    }
  }
}

static void parse_model(yyjson_val *model) {
  if(!model) return;
  json_copy(model, "screen", g.state.screen, sizeof(g.state.screen));
  parse_network(obj_get(model, "network"));
  parse_access(obj_get(model, "access"));
  parse_tx5dr(obj_get(model, "tx5dr"));
  parse_monitor(obj_get(model, "monitor"));
}

static void apply_patch(yyjson_val *patch) {
  if(!patch) return;
  yyjson_val *pathv = obj_get(patch, "path");
  yyjson_val *value = obj_get(patch, "value");
  if(!pathv || !yyjson_is_str(pathv)) return;
  const char *path = yyjson_get_str(pathv);
  if(strcmp(path, "screen") == 0 && value && yyjson_is_str(value)) set_str(g.state.screen, sizeof(g.state.screen), yyjson_get_str(value));
  else if(strcmp(path, "network") == 0) parse_network(value);
  else if(strcmp(path, "access") == 0) parse_access(value);
  else if(strcmp(path, "tx5dr") == 0) parse_tx5dr(value);
  else if(strcmp(path, "monitor") == 0) parse_monitor(value);
}

static void handle_ipc_line(const char *line) {
  yyjson_doc *doc = yyjson_read(line, strlen(line), 0);
  if(!doc) return;
  yyjson_val *root = yyjson_doc_get_root(doc);
  yyjson_val *tv = obj_get(root, "t");
  yyjson_val *idv = obj_get(root, "id");
  const char *t = tv && yyjson_is_str(tv) ? yyjson_get_str(tv) : "";
  const char *id = idv && yyjson_is_str(idv) ? yyjson_get_str(idv) : NULL;
  yyjson_val *payload = obj_get(root, "payload");

  if(strcmp(t, "daemon.hello") == 0 || strcmp(t, "panel.config") == 0) {
    ipc_send_ack(id, t);
  } else if(strcmp(t, "state.replace") == 0) {
    parse_model(payload);
    build_ui();
    ipc_send_ack(id, t);
  } else if(strcmp(t, "state.patch") == 0) {
    apply_patch(payload);
    build_ui();
    ipc_send_ack(id, t);
  } else if(strcmp(t, "screen.set") == 0) {
    json_copy(payload, "screen", g.state.screen, sizeof(g.state.screen));
    build_ui();
    ipc_send_ack(id, t);
  } else if(strcmp(t, "spectrum.update") == 0) {
    yyjson_val *bins = obj_get(payload, "bins");
    if(bins && yyjson_is_arr(bins)) {
      g.state.spectrum_len = 0;
      size_t idx, max; yyjson_val *v;
      yyjson_arr_foreach(bins, idx, max, v) {
        if(g.state.spectrum_len >= BARS) break;
        g.state.spectrum[g.state.spectrum_len++] = yyjson_is_num(v) ? (int)yyjson_get_int(v) : 0;
      }
      build_ui();
    }
    ipc_send_ack(id, t);
  } else if(strcmp(t, "toast.show") == 0) {
    json_copy(payload, "text", g.state.warning, sizeof(g.state.warning));
    ipc_send_ack(id, t);
  } else if(strcmp(t, "renderer.shutdown") == 0) {
    ipc_send_ack(id, t);
    yyjson_doc_free(doc);
    exit(0);
  }
  yyjson_doc_free(doc);
}

static bool path_exists(const char *path) {
  struct stat st;
  return path && path[0] && stat(path, &st) == 0;
}

static bool find_touch_by_path(char *out, size_t n) {
  DIR *dir = opendir("/dev/input/by-path");
  if(!dir) return false;
  struct dirent *ent;
  while((ent = readdir(dir)) != NULL) {
    const char *name = ent->d_name;
    if(name[0] == '.') continue;
    if(strstr(name, "event") && strstr(name, "spi")) {
      snprintf(out, n, "/dev/input/by-path/%s", name);
      if(path_exists(out)) { closedir(dir); return true; }
    }
  }
  closedir(dir);
  return false;
}

static bool find_touch_by_proc(char *out, size_t n) {
  FILE *f = fopen("/proc/bus/input/devices", "r");
  if(!f) return false;
  char line[512];
  bool in_touch = false;
  while(fgets(line, sizeof(line), f)) {
    if(line[0] == '\n' || line[0] == '\r') {
      in_touch = false;
      continue;
    }
    if(strncmp(line, "N:", 2) == 0) {
      in_touch = strstr(line, "ADS7846") || strstr(line, "XPT2046") || strstr(line, "Touchscreen");
    } else if(in_touch && strncmp(line, "H:", 2) == 0) {
      char *p = strstr(line, "event");
      while(p) {
        char *digits = p + 5;
        if(isdigit((unsigned char)*digits)) {
          snprintf(out, n, "/dev/input/event%d", atoi(digits));
          if(path_exists(out)) { fclose(f); return true; }
        }
        p = strstr(p + 5, "event");
      }
    }
  }
  fclose(f);
  return false;
}

static bool resolve_input_path(App *app) {
  if(path_exists(app->opt.input_path)) return true;
  char found[sizeof(app->opt.input_path)] = {0};
  if(find_touch_by_path(found, sizeof(found)) || find_touch_by_proc(found, sizeof(found))) {
    fprintf(stderr, "[tx5dr-panel-lvgl] touch input fallback: %s -> %s\n", app->opt.input_path, found);
    set_str(app->opt.input_path, sizeof(app->opt.input_path), found);
    return true;
  }
  return false;
}

static void ipc_disconnect(void) {
  if(g.ipc_fd >= 0) close(g.ipc_fd);
  g.ipc_fd = -1;
  g.ipc_used = 0;
  g.next_reconnect_ms = now_ms() + 2000;
}

static void ipc_connect_if_needed(void) {
  if(g.ipc_fd >= 0 || !g.opt.socket_path[0] || now_ms() < g.next_reconnect_ms) return;
  int fd = tx5dr_ipc_connect(g.opt.socket_path);
  if(fd < 0) { g.next_reconnect_ms = now_ms() + 2000; return; }
  fcntl(fd, F_SETFL, fcntl(fd, F_GETFL, 0) | O_NONBLOCK);
  g.ipc_fd = fd;
  ipc_send_hello();
}

static void ipc_poll(void) {
  ipc_connect_if_needed();
  if(g.ipc_fd < 0) return;
  struct pollfd pfd = { .fd = g.ipc_fd, .events = POLLIN, .revents = 0 };
  int pr = poll(&pfd, 1, 0);
  if(pr <= 0) return;
  if(pfd.revents & (POLLERR | POLLHUP | POLLNVAL)) { ipc_disconnect(); return; }
  char tmp[2048];
  ssize_t n = read(g.ipc_fd, tmp, sizeof(tmp));
  if(n <= 0) {
    if(errno != EAGAIN && errno != EWOULDBLOCK) ipc_disconnect();
    return;
  }
  for(ssize_t i = 0; i < n; i++) {
    if(tmp[i] == '\n') {
      g.ipc_buf[g.ipc_used] = 0;
      if(g.ipc_used > 0) handle_ipc_line(g.ipc_buf);
      g.ipc_used = 0;
    } else if(g.ipc_used < IPC_BUF_MAX) {
      g.ipc_buf[g.ipc_used++] = tmp[i];
    } else {
      g.ipc_used = 0;
      ipc_send_raw("{\"v\":1,\"t\":\"ipc.error\",\"ts\":0,\"payload\":{\"code\":\"message-too-large\"}}");
    }
  }
}

static void png_flush(lv_display_t *disp, const lv_area_t *area, uint8_t *px_map) {
  (void)disp;
  if(!g.png_fb) { lv_display_flush_ready(disp); return; }
  int32_t w = lv_area_get_width(area);
  for(int32_t y = area->y1; y <= area->y2; y++) {
    if(y < 0 || y >= TFT_H) continue;
    for(int32_t x = area->x1; x <= area->x2; x++) {
      if(x < 0 || x >= TFT_W) continue;
      size_t si = (size_t)(((y - area->y1) * w) + (x - area->x1)) * 4;
      size_t di = (size_t)(y * TFT_W + x) * 4;
      g.png_fb[di + 0] = px_map[si + 2];
      g.png_fb[di + 1] = px_map[si + 1];
      g.png_fb[di + 2] = px_map[si + 0];
      g.png_fb[di + 3] = 255;
    }
  }
  lv_display_flush_ready(disp);
}

static int init_display(void) {
  lv_tick_set_cb(lv_tick_cb);
  if(strcmp(g.opt.backend, "sdl") == 0) {
#if LV_USE_SDL
    g.display = lv_sdl_window_create(TFT_W, TFT_H);
    lv_sdl_mouse_create();
    lv_sdl_keyboard_create();
    return g.display ? 0 : 2;
#else
    snprintf(g.state.renderer_error, sizeof(g.state.renderer_error), "SDL backend not compiled");
    return 2;
#endif
  }
  if(strcmp(g.opt.backend, "fbdev") == 0) {
#if LV_USE_LINUX_FBDEV
    if(!path_exists(g.opt.fb_path)) {
      snprintf(g.state.renderer_error, sizeof(g.state.renderer_error), "display-unavailable: %s", g.opt.fb_path);
      fprintf(stderr, "[tx5dr-panel-lvgl] %s\n", g.state.renderer_error);
      return 3;
    }
    g.display = lv_linux_fbdev_create();
    if(!g.display || lv_linux_fbdev_set_file(g.display, g.opt.fb_path) != LV_RESULT_OK) return 3;
    int32_t w = lv_display_get_horizontal_resolution(g.display);
    int32_t h = lv_display_get_vertical_resolution(g.display);
    if(w != TFT_W || h != TFT_H) {
      fprintf(stderr, "[tx5dr-panel-lvgl] fbdev-size-mismatch: got %dx%d, expected 320x480. Set dtoverlay=tft35a:rotate=0 and reboot.\n", (int)w, (int)h);
      return 4;
    }
    lv_linux_fbdev_set_force_refresh(g.display, true);
#if LV_USE_EVDEV
    if(g.opt.input_path[0] && resolve_input_path(&g)) {
      lv_indev_t *touch = lv_evdev_create(LV_INDEV_TYPE_POINTER, g.opt.input_path);
      if(touch) {
        int min_x = g.cal.invert_x ? g.cal.raw_max_x : g.cal.raw_min_x;
        int max_x = g.cal.invert_x ? g.cal.raw_min_x : g.cal.raw_max_x;
        int min_y = g.cal.invert_y ? g.cal.raw_max_y : g.cal.raw_min_y;
        int max_y = g.cal.invert_y ? g.cal.raw_min_y : g.cal.raw_max_y;
        lv_evdev_set_swap_axes(touch, g.cal.swap_xy);
        lv_evdev_set_calibration(touch, min_x, min_y, max_x, max_y);
        g.state.touch_available = true;
      } else g.state.touch_available = false;
    } else g.state.touch_available = false;
#endif
    return 0;
#else
    snprintf(g.state.renderer_error, sizeof(g.state.renderer_error), "fbdev backend not compiled on this platform");
    return 3;
#endif
  }

  g.png_fb = calloc((size_t)TFT_W * TFT_H * 4, 1);
  g.png_draw = malloc((size_t)TFT_W * 80 * 4);
  if(!g.png_fb || !g.png_draw) return 5;
  g.display = lv_display_create(TFT_W, TFT_H);
  lv_display_set_color_format(g.display, LV_COLOR_FORMAT_XRGB8888);
  lv_display_set_flush_cb(g.display, png_flush);
  lv_display_set_buffers(g.display, g.png_draw, NULL, (uint32_t)((size_t)TFT_W * 80 * 4), LV_DISPLAY_RENDER_MODE_PARTIAL);
  return 0;
}

static void write_snapshot(void) {
  const char *path = g.opt.snapshot[0] ? g.opt.snapshot : "/tmp/tx5dr-panel-lvgl.png";
  if(!g.png_fb) return;
  if(tx5dr_write_rgba_png(path, TFT_W, TFT_H, g.png_fb) == 0) fprintf(stderr, "[tx5dr-panel-lvgl] wrote %s\n", path);
  else fprintf(stderr, "[tx5dr-panel-lvgl] failed to write %s\n", path);
}

static bool should_exit(void) {
  long elapsed = now_ms() - g.started_ms;
  if(strcmp(g.opt.backend, "png") == 0) return elapsed >= g.opt.once_ms;
  return elapsed >= g.opt.hold_ms;
}

int main(int argc, char **argv) {
  defaults(&g);
  parse_args(argc, argv, &g.opt);
  load_calibration(&g);
  g.ipc_fd = -1;
  g.started_ms = now_ms();
  fprintf(stderr, "[tx5dr-panel-lvgl] backend=%s profile=%s socket=%s fb=%s input=%s\n", g.opt.backend, g.opt.profile, g.opt.socket_path[0] ? g.opt.socket_path : "(none)", g.opt.fb_path, g.opt.input_path);
  lv_init();
  int init = init_display();
  if(init != 0 && strcmp(g.opt.backend, "png") != 0) return init;
  build_ui();
  while(!should_exit()) {
    ipc_poll();
    lv_timer_handler();
    sleep_ms(5);
  }
  if(strcmp(g.opt.backend, "png") == 0) {
    for(int i = 0; i < 20; i++) { lv_timer_handler(); sleep_ms(5); }
    write_snapshot();
  }
  if(g.ipc_fd >= 0) close(g.ipc_fd);
  free(g.png_fb);
  free(g.png_draw);
  return 0;
}
