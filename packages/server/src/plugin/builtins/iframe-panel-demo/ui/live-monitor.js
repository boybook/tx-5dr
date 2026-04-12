(function () {
  'use strict';

  var bridge = window.tx5dr;
  var signalFill = document.getElementById('signalFill');
  var labelText = document.getElementById('labelText');
  var counterText = document.getElementById('counterText');
  var logEl = document.getElementById('log');
  var MAX_LOG_LINES = 20;

  function appendLog(text) {
    var line = document.createElement('div');
    line.textContent = new Date().toLocaleTimeString() + ' ' + text;
    logEl.appendChild(line);
    while (logEl.children.length > MAX_LOG_LINES) {
      logEl.removeChild(logEl.firstChild);
    }
    logEl.scrollTop = logEl.scrollHeight;
  }

  // Receive real-time pushes from server
  bridge.onPush('tick', function (data) {
    var pct = Math.max(0, Math.min(100, (data.signalStrength + 50) / 40 * 100));
    signalFill.style.width = pct + '%';
    appendLog('Signal: ' + data.signalStrength.toFixed(1) + ' dBm');
  });

  bridge.onPush('counterUpdated', function (data) {
    counterText.textContent = data.counter;
  });

  bridge.onPush('labelUpdated', function (data) {
    labelText.textContent = data.label;
  });

  bridge.onPush('stateReset', function (data) {
    counterText.textContent = data.counter;
    labelText.textContent = data.label;
  });

  // Load initial state
  bridge.invoke('getState').then(function (state) {
    counterText.textContent = state.counter;
    labelText.textContent = state.label;
  }).catch(function () {
    // Use defaults
  });

  // Auto-resize
  var resizeObserver = new ResizeObserver(function () {
    var h = document.body.scrollHeight;
    if (h > 0) bridge.resize(h);
  });
  resizeObserver.observe(document.body);
  bridge.resize(document.body.scrollHeight);
})();
