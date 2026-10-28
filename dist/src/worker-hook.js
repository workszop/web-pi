// Keeps a handle on the app's worker so sibling modules (src/upload.js) can send it their own
// RPCs. Loaded as a classic script, so it runs before the module bundle creates the worker.
(function () {
  "use strict";
  const NativeWorker = window.Worker;
  window.__appWorkers = [];
  window.Worker = class extends NativeWorker {
    constructor(url, options) {
      super(url, options);
      this.scriptUrl = String(url);
      window.__appWorkers.push(this);
    }
  };
})();
