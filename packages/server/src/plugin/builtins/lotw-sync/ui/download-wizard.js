(function() {
  'use strict';

  var urlParams = new URLSearchParams(window.location.search);
  var locale = urlParams.get('_locale') || 'en';
  var callsign = urlParams.get('callsign') || '';
  var bridge = window.tx5dr;

  // ===== i18n =====
  var i18n = {
    zh: {
      description: '选择从 LoTW 下载确认记录的起始日期。',
      sinceDateLabel: '下载确认记录，起始日期',
      downloadBtn: '开始下载',
      downloading: '正在下载...',
      resultTitle: '下载结果',
      downloaded: '下载',
      matched: '匹配本地记录',
      updated: '新增导入',
      errors: '错误',
      success: '下载完成',
      failed: '下载失败',
    },
    en: {
      description: 'Select the date range for downloading LoTW confirmations.',
      sinceDateLabel: 'Download confirmations since',
      downloadBtn: 'Download',
      downloading: 'Downloading...',
      resultTitle: 'Results',
      downloaded: 'Downloaded',
      matched: 'Matched local QSOs',
      updated: 'New imports',
      errors: 'Errors',
      success: 'Download complete',
      failed: 'Download failed',
    },
  };
  var t = i18n[locale] || i18n.en;

  // ===== Elements =====
  var descText = document.getElementById('descText');
  var sinceDateLabel = document.getElementById('sinceDateLabel');
  var sinceDateInput = document.getElementById('sinceDate');
  var downloadBtn = document.getElementById('downloadBtn');
  var downloadBtnText = document.getElementById('downloadBtnText');
  var status = document.getElementById('status');
  var resultBox = document.getElementById('resultBox');
  var resultTitle = document.getElementById('resultTitle');
  var resultContent = document.getElementById('resultContent');

  // ===== Apply i18n =====
  descText.textContent = t.description;
  sinceDateLabel.textContent = t.sinceDateLabel;
  downloadBtnText.textContent = t.downloadBtn;
  resultTitle.textContent = t.resultTitle;

  // ===== Apply theme-aware color-scheme for date input =====
  var theme = urlParams.get('_theme') || 'dark';
  sinceDateInput.style.colorScheme = theme === 'light' ? 'light' : 'dark';
  bridge.onThemeChange(function(newTheme) {
    sinceDateInput.style.colorScheme = newTheme === 'light' ? 'light' : 'dark';
  });

  // ===== Default date: 30 days ago =====
  var defaultDate = new Date();
  defaultDate.setDate(defaultDate.getDate() - 30);
  sinceDateInput.value = defaultDate.toISOString().split('T')[0];

  // ===== Load last download time from config =====
  bridge.invoke('getLastDownloadTime', { callsign: callsign }).then(function(result) {
    if (result && result.lastDownloadTime) {
      var d = new Date(result.lastDownloadTime);
      sinceDateInput.value = d.toISOString().split('T')[0];
    }
  }).catch(function() {
    // Use default
  });

  // ===== Download =====
  downloadBtn.addEventListener('click', function() {
    var since = new Date(sinceDateInput.value).getTime();
    if (!since || isNaN(since)) return;

    downloadBtn.disabled = true;
    downloadBtnText.textContent = t.downloading;
    status.textContent = '';
    status.className = 'status';
    resultBox.style.display = 'none';

    bridge.invoke('performDownload', {
      callsign: callsign,
      since: since,
    }).then(function(result) {
      downloadBtn.disabled = false;
      downloadBtnText.textContent = t.downloadBtn;

      if (result.error) {
        status.textContent = t.failed + ': ' + result.error;
        status.className = 'status error';
        return;
      }

      status.textContent = t.success;
      status.className = 'status success';

      // Show result box
      var html = '';
      html += '<div class="stat"><span>' + t.downloaded + '</span><span class="stat-value">' + (result.downloaded || 0) + '</span></div>';
      html += '<div class="stat"><span>' + t.matched + '</span><span class="stat-value">' + (result.matched || 0) + '</span></div>';
      html += '<div class="stat"><span>' + t.updated + '</span><span class="stat-value">' + (result.updated || 0) + '</span></div>';

      if (result.errors && result.errors.length > 0) {
        html += '<div class="stat"><span>' + t.errors + '</span><span class="stat-value" style="color: var(--tx5dr-danger)">' + result.errors.length + '</span></div>';
        for (var i = 0; i < result.errors.length; i++) {
          html += '<div style="color: var(--tx5dr-danger); font-size: var(--tx5dr-font-size-sm); margin-top: 4px;">' + result.errors[i] + '</div>';
        }
      }

      resultContent.innerHTML = html;
      resultBox.style.display = 'block';
      reportHeight();
    }).catch(function(err) {
      downloadBtn.disabled = false;
      downloadBtnText.textContent = t.downloadBtn;
      status.textContent = t.failed + ': ' + (err.message || err);
      status.className = 'status error';
    });
  });

  // ===== Auto resize =====
  function reportHeight() {
    var h = document.body.scrollHeight;
    if (h > 0) bridge.resize(h);
  }
  var resizeObserver = new ResizeObserver(reportHeight);
  resizeObserver.observe(document.body);
  reportHeight();
})();
