(function() {
  'use strict';

  // Read locale from URL params (set by PluginIframeHost before init message).
  var urlParams = new URLSearchParams(window.location.search);
  var locale = urlParams.get('_locale') || 'en';
  var callsign = urlParams.get('callsign') || '';
  var bridge = window.tx5dr;

  // ===== i18n =====
  var I18N = {
    zh: {
      connectionTitle: 'QRZ.com 连接设置',
      apiKeyLabel: 'API 密钥',
      apiKeyPlaceholder: '输入 QRZ.com API 密钥',
      testBtn: '测试连接',
      testing: '测试中...',
      syncTitle: '同步设置',
      autoUpload: 'QSO 完成后自动上传',
      autoUploadDesc: '通联完成时自动将 QSO 记录上传到 QRZ.com',
      saveBtn: '保存',
      saving: '保存中...',
      saved: '已保存',
      saveFailed: '保存失败',
      connected: '连接成功',
      connectionFailed: '连接失败',
      lastSync: '上次同步',
      logbookInfo: '呼号: {callsign}, 日志数: {count}',
    },
    en: {
      connectionTitle: 'QRZ.com Connection',
      apiKeyLabel: 'API Key',
      apiKeyPlaceholder: 'Enter QRZ.com API key',
      testBtn: 'Test Connection',
      testing: 'Testing...',
      syncTitle: 'Sync Options',
      autoUpload: 'Auto-upload after QSO',
      autoUploadDesc: 'Automatically upload QSO records to QRZ.com when a contact is completed',
      saveBtn: 'Save',
      saving: 'Saving...',
      saved: 'Saved',
      saveFailed: 'Save failed',
      connected: 'Connected',
      connectionFailed: 'Connection failed',
      lastSync: 'Last sync',
      logbookInfo: 'Callsign: {callsign}, Logs: {count}',
    },
  };

  function t(key) {
    return (I18N[locale] || I18N.en)[key] || (I18N.en[key] || key);
  }

  // ===== DOM refs =====
  var apiKeyInput = document.getElementById('apiKey');
  var testBtn = document.getElementById('testBtn');
  var testResult = document.getElementById('testResult');
  var autoUploadToggle = document.getElementById('autoUpload');
  var saveBtn = document.getElementById('saveBtn');
  var saveResult = document.getElementById('saveResult');
  var lastSyncEl = document.getElementById('lastSync');

  // ===== Apply i18n to all static text =====
  function applyI18n() {
    document.getElementById('connectionTitle').textContent = t('connectionTitle');
    document.querySelector('[for="apiKey"]').textContent = t('apiKeyLabel');
    apiKeyInput.placeholder = t('apiKeyPlaceholder');
    testBtn.querySelector('.btn-text').textContent = t('testBtn');
    document.getElementById('syncTitle').textContent = t('syncTitle');
    document.getElementById('autoUploadLabel').textContent = t('autoUpload');
    document.getElementById('autoUploadDesc').textContent = t('autoUploadDesc');
    saveBtn.querySelector('.btn-text').textContent = t('saveBtn');
  }

  // ===== Load config =====
  function loadConfig() {
    bridge.invoke('getConfig', { callsign: callsign }).then(function(config) {
      if (!config) return;
      apiKeyInput.value = config.apiKey || '';
      autoUploadToggle.checked = !!config.autoUploadQSO;

      if (config.lastSyncTime) {
        lastSyncEl.textContent = t('lastSync') + ': ' + new Date(config.lastSyncTime).toLocaleString();
        lastSyncEl.classList.remove('hidden');
      }
    }).catch(function(err) {
      console.error('Failed to load config:', err);
    });
  }

  // ===== Test connection =====
  testBtn.addEventListener('click', function() {
    var apiKey = apiKeyInput.value.trim();
    if (!apiKey) return;

    testBtn.disabled = true;
    testBtn.querySelector('.btn-text').textContent = t('testing');
    testBtn.querySelector('.spinner').classList.remove('hidden');
    testResult.className = 'chip hidden';

    bridge.invoke('testConnection', { callsign: callsign, apiKey: apiKey }).then(function(result) {
      testBtn.disabled = false;
      testBtn.querySelector('.btn-text').textContent = t('testBtn');
      testBtn.querySelector('.spinner').classList.add('hidden');

      if (result.success) {
        var info = t('logbookInfo')
          .replace('{callsign}', result.callsign || '?')
          .replace('{count}', result.logbookCount != null ? result.logbookCount : '?');
        testResult.textContent = t('connected') + ' - ' + info;
        testResult.className = 'chip chip-success';
      } else {
        testResult.textContent = result.message || t('connectionFailed');
        testResult.className = 'chip chip-danger';
      }
    }).catch(function(err) {
      testBtn.disabled = false;
      testBtn.querySelector('.btn-text').textContent = t('testBtn');
      testBtn.querySelector('.spinner').classList.add('hidden');
      testResult.textContent = err.message || t('connectionFailed');
      testResult.className = 'chip chip-danger';
    });
  });

  // ===== Save config =====
  saveBtn.addEventListener('click', function() {
    var config = {
      apiKey: apiKeyInput.value.trim(),
      autoUploadQSO: autoUploadToggle.checked,
    };

    saveBtn.disabled = true;
    saveBtn.querySelector('.btn-text').textContent = t('saving');

    bridge.invoke('saveConfig', { callsign: callsign, config: config }).then(function() {
      saveBtn.disabled = false;
      saveBtn.querySelector('.btn-text').textContent = t('saveBtn');
      saveResult.textContent = t('saved');
      saveResult.className = 'chip chip-success';
      setTimeout(function() { saveResult.className = 'chip hidden'; }, 2000);
    }).catch(function(err) {
      saveBtn.disabled = false;
      saveBtn.querySelector('.btn-text').textContent = t('saveBtn');
      saveResult.textContent = t('saveFailed') + ': ' + (err.message || '');
      saveResult.className = 'chip chip-danger';
    });
  });

  // ===== Resize =====
  function reportHeight() {
    var h = document.body.scrollHeight;
    if (h > 0) bridge.resize(h);
  }
  var resizeObserver = new ResizeObserver(reportHeight);
  resizeObserver.observe(document.body);

  // ===== Init =====
  applyI18n();
  loadConfig();
})();
