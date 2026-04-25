/**
 * Browser runtime injected into every plugin iframe page.
 *
 * Type definitions for the public surface (`window.tx5dr`) are maintained in:
 *   packages/plugin-api/src/bridge.d.ts
 * Keep that file in sync when modifying the IIFE below.
 */
export function getPluginBridgeSdkScript(): string {
  return `/* TX-5DR Plugin Bridge SDK */
(function() {
  'use strict';
  var pending = {};
  var pushListeners = {};
  var themeListeners = [];
  var localeListeners = [];
  var stateListeners = [];
  var nextId = 1;
  var readyResolved = false;
  var resolveReady;
  var readyPromise = new Promise(function(resolve) {
    resolveReady = resolve;
  });

  function normalizeTheme(theme) {
    return theme === 'light' ? 'light' : 'dark';
  }

  function readUrlParams() {
    var query = new URLSearchParams(window.location.search || '');
    var params = {};
    query.forEach(function(value, key) {
      if (key.charAt(0) === '_' || key === 'auth_token' || key === 'token') return;
      params[key] = value;
    });
    return {
      params: params,
      theme: normalizeTheme(query.get('_theme')),
      locale: query.get('_locale') || 'en'
    };
  }

  var urlState = readUrlParams();
  var state = {
    params: urlState.params,
    theme: urlState.theme,
    locale: urlState.locale,
    pageSessionId: typeof window.__TX5DR_PAGE_SESSION_ID__ === 'string'
      ? window.__TX5DR_PAGE_SESSION_ID__
      : ''
  };

  // === Theme-aware CSS variable tokens ===
  var THEME_TOKENS = {
    dark: {
      '--tx5dr-bg': '#18181b',
      '--tx5dr-bg-content': '#27272a',
      '--tx5dr-bg-hover': '#3f3f46',
      '--tx5dr-text': '#fafafa',
      '--tx5dr-text-secondary': '#a1a1aa',
      '--tx5dr-border': '#3f3f46'
    },
    light: {
      '--tx5dr-bg': '#ffffff',
      '--tx5dr-bg-content': '#f4f4f5',
      '--tx5dr-bg-hover': '#e4e4e7',
      '--tx5dr-text': '#18181b',
      '--tx5dr-text-secondary': '#71717a',
      '--tx5dr-border': '#d4d4d8'
    }
  };

  function applyThemeTokens(theme) {
    var tokens = THEME_TOKENS[theme] || THEME_TOKENS.dark;
    var root = document.documentElement;
    for (var key in tokens) {
      root.style.setProperty(key, tokens[key]);
    }
  }

  function cloneParams(params) {
    return Object.assign({}, params || {});
  }

  function snapshotState() {
    return {
      params: cloneParams(state.params),
      theme: state.theme,
      locale: state.locale,
      pageSessionId: state.pageSessionId
    };
  }

  function sameParams(left, right) {
    left = left || {};
    right = right || {};
    var leftKeys = Object.keys(left);
    var rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    for (var i = 0; i < leftKeys.length; i += 1) {
      var key = leftKeys[i];
      if (left[key] !== right[key]) return false;
    }
    return true;
  }

  function notify(listeners, value) {
    listeners.slice().forEach(function(cb) {
      try { cb(value); } catch(err) { setTimeout(function() { throw err; }, 0); }
    });
  }

  function subscribe(listeners, cb) {
    listeners.push(cb);
    return function() {
      var index = listeners.indexOf(cb);
      if (index !== -1) listeners.splice(index, 1);
    };
  }

  function updateState(next, options) {
    options = options || {};
    var prev = snapshotState();
    var nextParams = next.params != null ? cloneParams(next.params) : state.params;
    var nextTheme = next.theme != null ? normalizeTheme(next.theme) : normalizeTheme(state.theme);
    var nextLocale = next.locale || state.locale || 'en';
    var nextPageSessionId = next.pageSessionId || state.pageSessionId || '';

    var paramsChanged = !sameParams(state.params, nextParams);
    var themeChanged = state.theme !== nextTheme;
    var localeChanged = state.locale !== nextLocale;
    var pageSessionChanged = state.pageSessionId !== nextPageSessionId;

    if (!paramsChanged && !themeChanged && !localeChanged && !pageSessionChanged) {
      if (options.resolveReady) resolveReadyOnce();
      return;
    }

    state.params = nextParams;
    state.theme = nextTheme;
    state.locale = nextLocale;
    state.pageSessionId = nextPageSessionId;

    if (themeChanged) {
      applyThemeTokens(state.theme);
      notify(themeListeners, state.theme);
    }
    if (localeChanged) {
      notify(localeListeners, state.locale);
    }

    notify(stateListeners, { previous: prev, current: snapshotState() });
    if (options.resolveReady) resolveReadyOnce();
  }

  function resolveReadyOnce() {
    if (!readyResolved) {
      readyResolved = true;
      resolveReady(snapshotState());
    }
  }

  applyThemeTokens(state.theme);

  window.addEventListener('message', function(e) {
    var msg = e.data;
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('tx5dr:')) return;
    if (msg.type === 'tx5dr:init') {
      updateState({
        params: msg.params || {},
        theme: msg.theme || 'dark',
        locale: msg.locale || 'en',
        pageSessionId: msg.pageSessionId
      }, { resolveReady: true });
      return;
    }
    if (msg.type === 'tx5dr:theme-changed') {
      updateState({ theme: msg.theme });
      return;
    }
    if (msg.type === 'tx5dr:push') {
      var cbs = pushListeners[msg.action];
      if (cbs) notify(cbs, msg.data);
      return;
    }
    if (msg.type === 'tx5dr:response' && msg.requestId && pending[msg.requestId]) {
      var p = pending[msg.requestId];
      delete pending[msg.requestId];
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    }
  });

  function request(type, payload) {
    return new Promise(function(resolve, reject) {
      var id = 'r' + (nextId++);
      pending[id] = { resolve: resolve, reject: reject };
      var msg = Object.assign({
        type: type,
        requestId: id,
        pageSessionId: state.pageSessionId
      }, payload);
      window.parent.postMessage(msg, '*');
    });
  }

  function base64FromArrayBuffer(buffer) {
    var bytes = new Uint8Array(buffer);
    var chunkSize = 0x8000;
    var binary = '';
    for (var i = 0; i < bytes.length; i += chunkSize) {
      var chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, Array.prototype.slice.call(chunk));
    }
    return btoa(binary);
  }

  function arrayBufferFromBase64(base64) {
    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  window.tx5dr = {
    get params() { return state.params; },
    get theme() { return state.theme; },
    get locale() { return state.locale; },
    get pageSessionId() { return state.pageSessionId; },
    ready: readyPromise,
    getState: function() { return snapshotState(); },
    onStateChange: function(cb) { return subscribe(stateListeners, cb); },
    onLocaleChange: function(cb) { return subscribe(localeListeners, cb); },
    storeGet: function(key, def) { return request('tx5dr:store:get', { key: key }).then(function(v) { return v != null ? v : def; }); },
    storeSet: function(key, value) { return request('tx5dr:store:set', { key: key, value: value }); },
    storeDelete: function(key) { return request('tx5dr:store:delete', { key: key }); },
    fileUpload: function(p, file) {
      return file.arrayBuffer().then(function(buf) {
        return request('tx5dr:file:upload', {
          path: p,
          data: base64FromArrayBuffer(buf)
        });
      });
    },
    fileRead: function(p) {
      return request('tx5dr:file:read', { path: p }).then(function(v) {
        if (!v) return null;
        return new Blob([arrayBufferFromBase64(v)]);
      });
    },
    fileDelete: function(p) { return request('tx5dr:file:delete', { path: p }); },
    fileList: function(prefix) { return request('tx5dr:file:list', { prefix: prefix || '' }); },
    requestClose: function() { window.parent.postMessage({ type: 'tx5dr:request-close' }, '*'); },
    onThemeChange: function(cb) { return subscribe(themeListeners, cb); },
    invoke: function(action, data) { return request('tx5dr:invoke', { action: action, data: data }); },
    onPush: function(action, cb) {
      if (!pushListeners[action]) pushListeners[action] = [];
      pushListeners[action].push(cb);
    },
    offPush: function(action, cb) {
      var arr = pushListeners[action];
      if (arr) pushListeners[action] = arr.filter(function(f) { return f !== cb; });
    },
    resize: function(height) { window.parent.postMessage({ type: 'tx5dr:resize', height: height }, '*'); },
  };
})();
`;
}
