(function() {
  'use strict';

  // Read locale and callsign from URL params (set by PluginIframeHost).
  var urlParams = new URLSearchParams(window.location.search);
  var locale = urlParams.get('_locale') || 'en';
  var callsign = urlParams.get('callsign') || '';
  var bridge = window.tx5dr;

  // ===== DXCC location rules (mirrors contracts/lotw.schema.ts) =====
  var LOTW_LOCATION_RULES = {
    1:   { stateLabel: 'Province',   countyLabel: null,              requiresState: true,  requiresCounty: false },
    5:   { stateLabel: 'Kunta',      countyLabel: null,              requiresState: true,  requiresCounty: false },
    6:   { stateLabel: 'State',      countyLabel: 'County',          requiresState: true,  requiresCounty: false },
    15:  { stateLabel: 'Oblast',     countyLabel: null,              requiresState: true,  requiresCounty: false },
    54:  { stateLabel: 'Oblast',     countyLabel: null,              requiresState: true,  requiresCounty: false },
    61:  { stateLabel: 'Oblast',     countyLabel: null,              requiresState: true,  requiresCounty: false },
    110: { stateLabel: 'State',      countyLabel: 'County',          requiresState: true,  requiresCounty: false },
    125: { stateLabel: 'Oblast',     countyLabel: null,              requiresState: true,  requiresCounty: false },
    150: { stateLabel: 'State',      countyLabel: null,              requiresState: true,  requiresCounty: false },
    151: { stateLabel: 'Oblast',     countyLabel: null,              requiresState: true,  requiresCounty: false },
    224: { stateLabel: 'Kunta',      countyLabel: null,              requiresState: true,  requiresCounty: false },
    291: { stateLabel: 'State',      countyLabel: 'County',          requiresState: true,  requiresCounty: false },
    318: { stateLabel: 'Province',   countyLabel: null,              requiresState: true,  requiresCounty: false },
    339: { stateLabel: 'Prefecture', countyLabel: 'City / Gun / Ku', requiresState: true,  requiresCounty: false },
  };

  function getLocationRule(dxccId) {
    if (!dxccId) return { stateLabel: 'State / Province', countyLabel: null, requiresState: false, requiresCounty: false };
    return LOTW_LOCATION_RULES[dxccId] || { stateLabel: 'State / Province', countyLabel: null, requiresState: false, requiresCounty: false };
  }

  // ===== i18n =====
  var I18N = {
    zh: {
      accountTitle: 'LoTW 账户',
      usernameLabel: '用户名',
      usernamePlaceholder: 'LoTW 用户名',
      passwordLabel: '密码',
      passwordPlaceholder: 'LoTW 密码',
      verifyBtn: '验证',
      verifying: '验证中...',
      connected: '连接成功',
      connectionFailed: '连接失败',
      authFailed: '用户名或密码错误',
      certTitle: '证书管理',
      certHint: '上传从 TQSL 导出的 .p12 证书文件（不带密码保护）。',
      uploadCertBtn: '上传 .p12 证书',
      uploading: '上传中...',
      certUploaded: '证书已导入',
      certUploadFailed: '导入失败',
      certPasswordProtected: '证书受密码保护，请导出无密码的 .p12 文件',
      certInvalid: '无效的证书文件',
      certEmpty: '尚未上传证书',
      certDeleteConfirm: '确定要删除此证书吗？',
      certValid: '有效',
      certExpired: '已过期',
      certNotYetValid: '尚未生效',
      certDxcc: 'DXCC',
      certValidRange: '证书有效期',
      certQsoRange: 'QSO 日期范围',
      deleteBtn: '删除',
      locationTitle: '上传台站位置',
      callsignLabel: '呼号',
      dxccLabel: 'DXCC 实体编号',
      gridLabel: '网格定位',
      iotaLabel: 'IOTA',
      cqZoneLabel: 'CQ 区',
      ituZoneLabel: 'ITU 区',
      stateLabel: '州/省/地区',
      countyLabel: '县/区',
      syncTitle: '同步设置',
      autoUpload: 'QSO 完成后自动上传',
      autoUploadDesc: '通联完成时自动签名并上传 QSO 记录到 LoTW',
      checkReadiness: '检查上传就绪状态',
      checking: '检查中...',
      preflightReady: '已就绪，可以上传',
      preflightNotReady: '未就绪，存在问题',
      saveBtn: '保存',
      saving: '保存中...',
      saved: '已保存',
      saveFailed: '保存失败',
      lastUpload: '上次上传',
      lastDownload: '上次下载',
    },
    en: {
      accountTitle: 'LoTW Account',
      usernameLabel: 'Username',
      usernamePlaceholder: 'LoTW username',
      passwordLabel: 'Password',
      passwordPlaceholder: 'LoTW password',
      verifyBtn: 'Verify',
      verifying: 'Verifying...',
      connected: 'Connected',
      connectionFailed: 'Connection failed',
      authFailed: 'Invalid username or password',
      certTitle: 'Certificates',
      certHint: 'Upload your .p12 certificate file exported from TQSL (without password protection).',
      uploadCertBtn: 'Upload .p12 Certificate',
      uploading: 'Uploading...',
      certUploaded: 'Certificate imported',
      certUploadFailed: 'Import failed',
      certPasswordProtected: 'Certificate is password protected. Export a .p12 file without a password.',
      certInvalid: 'Invalid certificate file',
      certEmpty: 'No certificates uploaded yet',
      certDeleteConfirm: 'Delete this certificate?',
      certValid: 'Valid',
      certExpired: 'Expired',
      certNotYetValid: 'Not Yet Valid',
      certDxcc: 'DXCC',
      certValidRange: 'Certificate validity',
      certQsoRange: 'QSO date range',
      deleteBtn: 'Delete',
      locationTitle: 'Upload Location',
      callsignLabel: 'Callsign',
      dxccLabel: 'DXCC Entity ID',
      gridLabel: 'Grid Square',
      iotaLabel: 'IOTA',
      cqZoneLabel: 'CQ Zone',
      ituZoneLabel: 'ITU Zone',
      stateLabel: 'State / Province',
      countyLabel: 'County',
      syncTitle: 'Sync Options',
      autoUpload: 'Auto-upload after QSO',
      autoUploadDesc: 'Automatically sign and upload QSO records to LoTW when a contact is completed',
      checkReadiness: 'Check Readiness',
      checking: 'Checking...',
      preflightReady: 'Ready to upload',
      preflightNotReady: 'Not ready, issues found',
      saveBtn: 'Save',
      saving: 'Saving...',
      saved: 'Saved',
      saveFailed: 'Save failed',
      lastUpload: 'Last upload',
      lastDownload: 'Last download',
    },
  };

  function t(key) {
    return (I18N[locale] || I18N.en)[key] || (I18N.en[key] || key);
  }

  // ===== DOM refs =====
  var usernameInput = document.getElementById('username');
  var passwordInput = document.getElementById('password');
  var testBtn = document.getElementById('testBtn');
  var testResult = document.getElementById('testResult');
  var uploadCertBtn = document.getElementById('uploadCertBtn');
  var certFileInput = document.getElementById('certFileInput');
  var certUploadResult = document.getElementById('certUploadResult');
  var certListEl = document.getElementById('certList');
  var locCallsignInput = document.getElementById('locCallsign');
  var locDxccInput = document.getElementById('locDxcc');
  var locGridInput = document.getElementById('locGrid');
  var locIotaInput = document.getElementById('locIota');
  var locCqZoneInput = document.getElementById('locCqZone');
  var locItuZoneInput = document.getElementById('locItuZone');
  var locStateInput = document.getElementById('locState');
  var locCountyInput = document.getElementById('locCounty');
  var stateRow = document.getElementById('stateRow');
  var countyGroup = document.getElementById('countyGroup');
  var stateLabelEl = document.getElementById('stateLabel');
  var countyLabelEl = document.getElementById('countyLabel');
  var autoUploadToggle = document.getElementById('autoUpload');
  var preflightBtn = document.getElementById('preflightBtn');
  var preflightResultEl = document.getElementById('preflightResult');
  var saveBtn = document.getElementById('saveBtn');
  var saveResult = document.getElementById('saveResult');
  var lastSyncEl = document.getElementById('lastSync');

  var certificates = [];

  // ===== Apply i18n =====
  function applyI18n() {
    document.getElementById('accountTitle').textContent = t('accountTitle');
    document.querySelector('[for="username"]').textContent = t('usernameLabel');
    usernameInput.placeholder = t('usernamePlaceholder');
    document.querySelector('[for="password"]').textContent = t('passwordLabel');
    passwordInput.placeholder = t('passwordPlaceholder');
    testBtn.querySelector('.btn-text').textContent = t('verifyBtn');
    document.getElementById('certTitle').textContent = t('certTitle');
    document.getElementById('certHint').textContent = t('certHint');
    document.getElementById('uploadCertText').textContent = t('uploadCertBtn');
    document.getElementById('locationTitle').textContent = t('locationTitle');
    document.querySelector('[for="locCallsign"]').textContent = t('callsignLabel');
    document.querySelector('[for="locDxcc"]').textContent = t('dxccLabel');
    document.querySelector('[for="locGrid"]').textContent = t('gridLabel');
    document.querySelector('[for="locIota"]').textContent = t('iotaLabel');
    document.querySelector('[for="locCqZone"]').textContent = t('cqZoneLabel');
    document.querySelector('[for="locItuZone"]').textContent = t('ituZoneLabel');
    document.getElementById('syncTitle').textContent = t('syncTitle');
    document.getElementById('autoUploadLabel').textContent = t('autoUpload');
    document.getElementById('autoUploadDesc').textContent = t('autoUploadDesc');
    document.getElementById('preflightText').textContent = t('checkReadiness');
    saveBtn.querySelector('.btn-text').textContent = t('saveBtn');
  }

  // ===== Location field visibility based on DXCC =====
  function updateLocationFields() {
    var dxccId = parseInt(locDxccInput.value, 10);
    var rule = getLocationRule(dxccId || 0);

    stateLabelEl.textContent = rule.stateLabel || t('stateLabel');
    if (rule.countyLabel) {
      countyLabelEl.textContent = rule.countyLabel;
      countyGroup.classList.remove('hidden');
    } else {
      countyGroup.classList.add('hidden');
    }

    // Always show state row (even when not required, user can optionally fill it)
    stateRow.classList.remove('hidden');
  }

  locDxccInput.addEventListener('input', updateLocationFields);

  // ===== Load config =====
  function loadConfig() {
    bridge.invoke('getConfig', { callsign: callsign }).then(function(config) {
      if (!config) return;
      usernameInput.value = config.username || '';
      passwordInput.value = config.password || '';
      autoUploadToggle.checked = !!config.autoUploadQSO;

      if (config.uploadLocation) {
        var loc = config.uploadLocation;
        locCallsignInput.value = loc.callsign || '';
        locDxccInput.value = loc.dxccId || '';
        locGridInput.value = loc.gridSquare || '';
        locIotaInput.value = loc.iota || '';
        locCqZoneInput.value = loc.cqZone || '';
        locItuZoneInput.value = loc.ituZone || '';
        locStateInput.value = loc.state || '';
        locCountyInput.value = loc.county || '';
      }

      updateLocationFields();

      var syncParts = [];
      if (config.lastUploadTime) {
        syncParts.push(t('lastUpload') + ': ' + new Date(config.lastUploadTime).toLocaleString());
      }
      if (config.lastDownloadTime) {
        syncParts.push(t('lastDownload') + ': ' + new Date(config.lastDownloadTime).toLocaleString());
      }
      if (syncParts.length > 0) {
        lastSyncEl.textContent = syncParts.join(' | ');
        lastSyncEl.classList.remove('hidden');
      }
    }).catch(function(err) {
      console.error('Failed to load config:', err);
    });

    loadCertificates();
  }

  // ===== Certificate management =====
  function loadCertificates() {
    bridge.invoke('getCertificates', { callsign: callsign }).then(function(result) {
      certificates = (result && result.certificates) || [];
      renderCertificates();
    }).catch(function() {
      certificates = [];
      renderCertificates();
    });
  }

  function renderCertificates() {
    if (certificates.length === 0) {
      certListEl.innerHTML = '<div class="cert-empty">' + t('certEmpty') + '</div>';
      return;
    }

    var html = '';
    for (var i = 0; i < certificates.length; i++) {
      var cert = certificates[i];
      var statusClass = 'cert-status-' + cert.status;
      var statusText = cert.status === 'valid' ? t('certValid')
        : cert.status === 'expired' ? t('certExpired')
        : t('certNotYetValid');

      var validFrom = new Date(cert.validFrom).toLocaleDateString();
      var validTo = new Date(cert.validTo).toLocaleDateString();
      var qsoStart = new Date(cert.qsoStartDate).toLocaleDateString();
      var qsoEnd = new Date(cert.qsoEndDate).toLocaleDateString();

      html += '<div class="cert-card" data-id="' + cert.id + '">'
        + '<div class="cert-info">'
        + '<div class="cert-callsign">' + escapeHtml(cert.callsign) + ' <span class="cert-status ' + statusClass + '">' + statusText + '</span></div>'
        + '<div class="cert-meta">'
        + t('certDxcc') + ': ' + cert.dxccId + '<br>'
        + t('certValidRange') + ': ' + validFrom + ' ~ ' + validTo + '<br>'
        + t('certQsoRange') + ': ' + qsoStart + ' ~ ' + qsoEnd
        + '</div>'
        + '</div>'
        + '<div class="cert-actions">'
        + '<button class="btn btn-danger cert-delete-btn" data-id="' + cert.id + '">' + t('deleteBtn') + '</button>'
        + '</div>'
        + '</div>';
    }
    certListEl.innerHTML = html;

    // Attach delete handlers
    var deleteButtons = certListEl.querySelectorAll('.cert-delete-btn');
    for (var j = 0; j < deleteButtons.length; j++) {
      deleteButtons[j].addEventListener('click', handleDeleteCert);
    }
  }

  function handleDeleteCert(e) {
    var certId = e.currentTarget.getAttribute('data-id');
    if (!confirm(t('certDeleteConfirm'))) return;

    bridge.invoke('deleteCertificate', { callsign: callsign, id: certId }).then(function() {
      loadCertificates();
    }).catch(function(err) {
      console.error('Delete failed:', err);
    });
  }

  // File upload
  uploadCertBtn.addEventListener('click', function() {
    certFileInput.click();
  });

  certFileInput.addEventListener('change', function() {
    var file = certFileInput.files && certFileInput.files[0];
    if (!file) return;
    certFileInput.value = '';

    uploadCertBtn.disabled = true;
    document.getElementById('uploadCertText').textContent = t('uploading');
    document.getElementById('uploadCertSpinner').classList.remove('hidden');
    certUploadResult.className = 'chip hidden';

    var reader = new FileReader();
    reader.onload = function(ev) {
      var arrayBuffer = ev.target.result;
      // Convert ArrayBuffer to base64 for JSON transport
      var bytes = new Uint8Array(arrayBuffer);
      var binary = '';
      for (var i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      var base64 = btoa(binary);

      bridge.invoke('importCertificate', { callsign: callsign, data: base64 }).then(function(result) {
        uploadCertBtn.disabled = false;
        document.getElementById('uploadCertText').textContent = t('uploadCertBtn');
        document.getElementById('uploadCertSpinner').classList.add('hidden');

        if (result && result.success) {
          certUploadResult.textContent = t('certUploaded');
          certUploadResult.className = 'chip chip-success';
          loadCertificates();
        } else {
          certUploadResult.textContent = t('certUploadFailed');
          certUploadResult.className = 'chip chip-danger';
        }
        setTimeout(function() { certUploadResult.className = 'chip hidden'; }, 3000);
      }).catch(function(err) {
        uploadCertBtn.disabled = false;
        document.getElementById('uploadCertText').textContent = t('uploadCertBtn');
        document.getElementById('uploadCertSpinner').classList.add('hidden');

        var msg = (err && err.message) || '';
        if (msg.includes('password_protected')) {
          certUploadResult.textContent = t('certPasswordProtected');
        } else if (msg.includes('invalid')) {
          certUploadResult.textContent = t('certInvalid');
        } else {
          certUploadResult.textContent = t('certUploadFailed') + (msg ? ': ' + msg : '');
        }
        certUploadResult.className = 'chip chip-danger';
        setTimeout(function() { certUploadResult.className = 'chip hidden'; }, 5000);
      });
    };
    reader.onerror = function() {
      uploadCertBtn.disabled = false;
      document.getElementById('uploadCertText').textContent = t('uploadCertBtn');
      document.getElementById('uploadCertSpinner').classList.add('hidden');
      certUploadResult.textContent = t('certUploadFailed');
      certUploadResult.className = 'chip chip-danger';
    };
    reader.readAsArrayBuffer(file);
  });

  // ===== Test connection =====
  testBtn.addEventListener('click', function() {
    // Save current credentials temporarily so testConnection can read them
    var tmpConfig = buildConfig();
    bridge.invoke('saveConfig', { callsign: callsign, config: tmpConfig }).then(function() {
      testBtn.disabled = true;
      testBtn.querySelector('.btn-text').textContent = t('verifying');
      testBtn.querySelector('.spinner').classList.remove('hidden');
      testResult.className = 'chip hidden';

      return bridge.invoke('testConnection', { callsign: callsign });
    }).then(function(result) {
      testBtn.disabled = false;
      testBtn.querySelector('.btn-text').textContent = t('verifyBtn');
      testBtn.querySelector('.spinner').classList.add('hidden');

      if (result && result.success) {
        testResult.textContent = t('connected');
        testResult.className = 'chip chip-success';
      } else {
        var msg = result && result.message;
        if (msg === 'lotw_auth_failed') {
          testResult.textContent = t('authFailed');
        } else {
          testResult.textContent = msg || t('connectionFailed');
        }
        testResult.className = 'chip chip-danger';
      }
    }).catch(function(err) {
      testBtn.disabled = false;
      testBtn.querySelector('.btn-text').textContent = t('verifyBtn');
      testBtn.querySelector('.spinner').classList.add('hidden');
      testResult.textContent = (err && err.message) || t('connectionFailed');
      testResult.className = 'chip chip-danger';
    });
  });

  // ===== Preflight check =====
  preflightBtn.addEventListener('click', function() {
    preflightBtn.disabled = true;
    document.getElementById('preflightText').textContent = t('checking');
    document.getElementById('preflightSpinner').classList.remove('hidden');
    preflightResultEl.classList.add('hidden');

    // Save first so preflight reads latest config
    var tmpConfig = buildConfig();
    bridge.invoke('saveConfig', { callsign: callsign, config: tmpConfig }).then(function() {
      return bridge.invoke('getUploadPreflight', { callsign: callsign });
    }).then(function(result) {
      preflightBtn.disabled = false;
      document.getElementById('preflightText').textContent = t('checkReadiness');
      document.getElementById('preflightSpinner').classList.add('hidden');

      if (!result) {
        preflightResultEl.classList.add('hidden');
        return;
      }

      var html = '<div class="preflight-ready ' + (result.ready ? 'preflight-ready-yes' : 'preflight-ready-no') + '">'
        + (result.ready ? t('preflightReady') : t('preflightNotReady'))
        + '</div>';

      if (result.issues && result.issues.length > 0) {
        for (var i = 0; i < result.issues.length; i++) {
          var issue = result.issues[i];
          var icon = issue.severity === 'error' ? '&#x2716;' : issue.severity === 'warning' ? '&#x26A0;' : '&#x2139;';
          html += '<div class="preflight-issue preflight-issue-' + issue.severity + '">'
            + '<span class="preflight-icon">' + icon + '</span>'
            + '<span>' + escapeHtml(issue.message) + '</span>'
            + '</div>';
        }
      }

      preflightResultEl.innerHTML = html;
      preflightResultEl.classList.remove('hidden');
    }).catch(function(err) {
      preflightBtn.disabled = false;
      document.getElementById('preflightText').textContent = t('checkReadiness');
      document.getElementById('preflightSpinner').classList.add('hidden');
      preflightResultEl.innerHTML = '<div class="preflight-ready preflight-ready-no">'
        + escapeHtml((err && err.message) || 'Check failed') + '</div>';
      preflightResultEl.classList.remove('hidden');
    });
  });

  // ===== Save config =====
  function buildConfig() {
    var dxccVal = parseInt(locDxccInput.value, 10);
    return {
      username: usernameInput.value.trim(),
      password: passwordInput.value.trim(),
      uploadLocation: {
        callsign: locCallsignInput.value.trim().toUpperCase(),
        dxccId: isNaN(dxccVal) ? undefined : dxccVal,
        gridSquare: locGridInput.value.trim().toUpperCase(),
        cqZone: locCqZoneInput.value.trim(),
        ituZone: locItuZoneInput.value.trim(),
        iota: locIotaInput.value.trim().toUpperCase() || undefined,
        state: locStateInput.value.trim().toUpperCase() || undefined,
        county: locCountyInput.value.trim().toUpperCase() || undefined,
      },
      autoUploadQSO: autoUploadToggle.checked,
    };
  }

  saveBtn.addEventListener('click', function() {
    var config = buildConfig();

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
      saveResult.textContent = t('saveFailed') + ': ' + ((err && err.message) || '');
      saveResult.className = 'chip chip-danger';
    });
  });

  // ===== Utilities =====
  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ===== Resize =====
  function reportHeight() {
    var h = document.body.scrollHeight;
    if (h > 0) bridge.resize(h);
  }
  var resizeObserver = new ResizeObserver(reportHeight);
  resizeObserver.observe(document.body);

  // ===== Init =====
  applyI18n();
  updateLocationFields();
  loadConfig();
})();
