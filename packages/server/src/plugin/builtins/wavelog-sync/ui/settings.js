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
      connectionTitle: 'WaveLog 连接设置',
      urlLabel: '服务器 URL',
      urlPlaceholder: 'https://your-wavelog.example.com',
      apiKeyLabel: 'API 密钥',
      apiKeyPlaceholder: '输入 WaveLog API 密钥',
      testBtn: '测试连接',
      testing: '测试中...',
      stationLabel: '电台配置',
      stationPlaceholder: '请先测试连接',
      radioNameLabel: '电台名称',
      syncTitle: '同步设置',
      autoUpload: 'QSO 完成后自动上传',
      autoUploadDesc: '通联完成时自动将 QSO 记录上传到 WaveLog',
      saveBtn: '保存',
      saving: '保存中...',
      saved: '已保存',
      saveFailed: '保存失败',
      connected: '连接成功',
      connectionFailed: '连接失败',
      lastSync: '上次同步',
    },
    en: {
      connectionTitle: 'WaveLog Connection',
      urlLabel: 'Server URL',
      urlPlaceholder: 'https://your-wavelog.example.com',
      apiKeyLabel: 'API Key',
      apiKeyPlaceholder: 'Enter WaveLog API key',
      testBtn: 'Test Connection',
      testing: 'Testing...',
      stationLabel: 'Station Profile',
      stationPlaceholder: 'Test connection first',
      radioNameLabel: 'Radio Name',
      syncTitle: 'Sync Options',
      autoUpload: 'Auto-upload after QSO',
      autoUploadDesc: 'Automatically upload QSO records to WaveLog when a contact is completed',
      saveBtn: 'Save',
      saving: 'Saving...',
      saved: 'Saved',
      saveFailed: 'Save failed',
      connected: 'Connected',
      connectionFailed: 'Connection failed',
      lastSync: 'Last sync',
    },
  };

  function t(key) {
    return (I18N[locale] || I18N.en)[key] || (I18N.en[key] || key);
  }

  // ===== DOM refs =====
  var urlInput = document.getElementById('url');
  var apiKeyInput = document.getElementById('apiKey');
  var testBtn = document.getElementById('testBtn');
  var testResult = document.getElementById('testResult');
  var stationSelect = document.getElementById('stationSelect');
  var radioNameInput = document.getElementById('radioName');
  var autoUploadToggle = document.getElementById('autoUpload');
  var saveBtn = document.getElementById('saveBtn');
  var saveResult = document.getElementById('saveResult');
  var lastSyncEl = document.getElementById('lastSync');

  var stations = [];

  // ===== Apply i18n to all static text =====
  function applyI18n() {
    document.getElementById('connectionTitle').textContent = t('connectionTitle');
    document.querySelector('[for="url"]').textContent = t('urlLabel');
    urlInput.placeholder = t('urlPlaceholder');
    document.querySelector('[for="apiKey"]').textContent = t('apiKeyLabel');
    apiKeyInput.placeholder = t('apiKeyPlaceholder');
    testBtn.querySelector('.btn-text').textContent = t('testBtn');
    document.querySelector('[for="stationSelect"]').textContent = t('stationLabel');
    document.querySelector('[for="radioName"]').textContent = t('radioNameLabel');
    document.getElementById('syncTitle').textContent = t('syncTitle');
    document.getElementById('autoUploadLabel').textContent = t('autoUpload');
    document.getElementById('autoUploadDesc').textContent = t('autoUploadDesc');
    saveBtn.querySelector('.btn-text').textContent = t('saveBtn');
  }

  // ===== Load config =====
  function loadConfig() {
    bridge.invoke('getConfig', { callsign: callsign }).then(function(config) {
      if (!config) return;
      urlInput.value = config.url || '';
      apiKeyInput.value = config.apiKey || '';
      radioNameInput.value = config.radioName || 'TX5DR';
      autoUploadToggle.checked = !!config.autoUploadQSO;

      if (config.lastSyncTime) {
        lastSyncEl.textContent = t('lastSync') + ': ' + new Date(config.lastSyncTime).toLocaleString();
        lastSyncEl.classList.remove('hidden');
      }

      if (config.url && config.apiKey) {
        bridge.invoke('getStations', { callsign: callsign, url: config.url, apiKey: config.apiKey }).then(function(result) {
          if (result && result.stations) {
            stations = result.stations;
            populateStations(config.stationId);
          }
        }).catch(function() {
          if (config.stationId) {
            var opt = document.createElement('option');
            opt.value = config.stationId;
            opt.textContent = 'Station #' + config.stationId;
            stationSelect.innerHTML = '';
            stationSelect.appendChild(opt);
            stationSelect.value = config.stationId;
          }
        });
      }
    }).catch(function(err) {
      console.error('Failed to load config:', err);
    });
  }

  function populateStations(selectedId) {
    stationSelect.innerHTML = '';
    if (stations.length === 0) {
      var empty = document.createElement('option');
      empty.value = '';
      empty.textContent = t('stationPlaceholder');
      stationSelect.appendChild(empty);
      return;
    }
    for (var i = 0; i < stations.length; i++) {
      var s = stations[i];
      var opt = document.createElement('option');
      opt.value = s.station_id;
      opt.textContent = s.station_profile_name + ' (' + s.station_callsign + ')';
      if (s.station_gridsquare) opt.textContent += ' [' + s.station_gridsquare + ']';
      stationSelect.appendChild(opt);
    }
    if (selectedId) {
      stationSelect.value = selectedId;
    } else if (stations.length === 1) {
      stationSelect.value = stations[0].station_id;
    }
  }

  // ===== Test connection =====
  testBtn.addEventListener('click', function() {
    var url = urlInput.value.trim();
    var apiKey = apiKeyInput.value.trim();
    if (!url || !apiKey) return;

    testBtn.disabled = true;
    testBtn.querySelector('.btn-text').textContent = t('testing');
    testBtn.querySelector('.spinner').classList.remove('hidden');
    testResult.className = 'chip hidden';

    bridge.invoke('testConnection', { callsign: callsign, url: url, apiKey: apiKey }).then(function(result) {
      testBtn.disabled = false;
      testBtn.querySelector('.btn-text').textContent = t('testBtn');
      testBtn.querySelector('.spinner').classList.add('hidden');

      if (result.success) {
        testResult.textContent = t('connected');
        testResult.className = 'chip chip-success';
        if (result.stations) {
          stations = result.stations;
          populateStations(stationSelect.value);
        }
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
      url: urlInput.value.trim(),
      apiKey: apiKeyInput.value.trim(),
      stationId: stationSelect.value,
      radioName: radioNameInput.value.trim() || 'TX5DR',
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
