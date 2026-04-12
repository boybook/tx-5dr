(function () {
  'use strict';

  var bridge = window.tx5dr;
  var labelInput = document.getElementById('labelInput');
  var setLabelBtn = document.getElementById('setLabelBtn');
  var incrementBtn = document.getElementById('incrementBtn');
  var counterValue = document.getElementById('counterValue');
  var resetBtn = document.getElementById('resetBtn');

  // Load initial state
  bridge.invoke('getState').then(function (state) {
    counterValue.textContent = state.counter;
    labelInput.value = state.label;
  }).catch(function () {
    // Use defaults
  });

  // Increment counter
  incrementBtn.addEventListener('click', function () {
    bridge.invoke('increment').then(function (result) {
      counterValue.textContent = result.counter;
    });
  });

  // Set label
  setLabelBtn.addEventListener('click', function () {
    var label = labelInput.value.trim();
    if (label) {
      bridge.invoke('setLabel', { label: label });
    }
  });

  // Enter key on label input triggers set
  labelInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      setLabelBtn.click();
    }
  });

  // Reset
  resetBtn.addEventListener('click', function () {
    bridge.invoke('reset').then(function (result) {
      counterValue.textContent = result.counter;
      labelInput.value = result.label;
    });
  });

  // Auto-resize
  var resizeObserver = new ResizeObserver(function () {
    var h = document.body.scrollHeight;
    if (h > 0) bridge.resize(h);
  });
  resizeObserver.observe(document.body);
  bridge.resize(document.body.scrollHeight);
})();
