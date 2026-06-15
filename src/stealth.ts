// DISABLED on patch branch.
//
// Patchright now handles automation fingerprint patches at the CDP/C++ layer
// (navigator.webdriver, chrome.runtime, plugins, Runtime.enable traces, etc).
// JS-shim stealth is itself detectable — sites probe for descriptor accessors
// that don't match a real browser. Patchright's native patches don't have that
// problem.
//
// This file is kept (not deleted) as a rollback path: if patchright proves
// insufficient on Google specifically, re-import STEALTH_INIT_SCRIPT in
// chrome.ts and re-add `context.addInitScript({ content: STEALTH_INIT_SCRIPT })`.
//
// Original docstring:
// Browser fingerprint shim — runs in every page before site JS executes.
//
// Patches the headless tells that Google's BotGuard reads first. With a
// residential IP this typically drops /sorry/ rates from "every request" to
// "occasionally"; without it, even a clean residential IP gets flagged because
// the JS-visible properties scream automation.
//
// This is a focused subset of what puppeteer-extra-plugin-stealth does — we
// can't use that plugin (Playwright, not Puppeteer; we connect over CDP, not
// launch). The overrides below cover the highest-leverage signals: webdriver
// flag, plugins/languages emptiness, chrome.runtime presence, the Notification
// permissions quirk, and SwiftShader WebGL exposure.

export const STEALTH_INIT_SCRIPT = `
(() => {
  // 1. navigator.webdriver — the single most-checked tell. Real Chrome
  // returns undefined; headless returns true. Redefine the accessor on the
  // prototype so probes that read the descriptor can't see "writable: true".
  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      get: () => undefined,
      configurable: true,
    });
  } catch (_) {}

  // 2. navigator.languages — empty array in headless, populated in real
  // Chrome. Match the Accept-Language header we send (Belgian locale chain).
  // Mismatch between header and JS array is itself a fingerprint flag.
  try {
    Object.defineProperty(Navigator.prototype, 'languages', {
      get: () => ['en-BE', 'en', 'nl-BE', 'fr-BE'],
      configurable: true,
    });
  } catch (_) {}

  // 3. navigator.plugins — empty in headless. Real Chrome ships with three
  // built-in PDF plugins. Length 0 is itself a flag, so populate.
  try {
    const fakePlugins = [
      { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
      { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: '', length: 1 },
      { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: '', length: 1 },
    ];
    Object.defineProperty(Navigator.prototype, 'plugins', {
      get: () => fakePlugins,
      configurable: true,
    });
    Object.defineProperty(Navigator.prototype, 'mimeTypes', {
      get: () => [{ type: 'application/pdf', suffixes: 'pdf', description: '' }],
      configurable: true,
    });
  } catch (_) {}

  // 4. chrome.runtime — present in real Chrome with a few bound APIs. Headless
  // omits it entirely on non-extension pages.
  try {
    if (!window.chrome) (window).chrome = {};
    if (!(window).chrome.runtime) (window).chrome.runtime = {};
  } catch (_) {}

  // 5. Notification permission/permissions.query mismatch — headless lies.
  // Notification.permission says 'default' but permissions.query({name:'notifications'})
  // returns 'denied'. Real Chrome agrees. Stealth probes diff these two.
  try {
    const originalQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
    window.navigator.permissions.query = (parameters) => {
      if (parameters && parameters.name === 'notifications') {
        return Promise.resolve({
          state: typeof Notification !== 'undefined' ? Notification.permission : 'default',
          name: 'notifications',
          onchange: null,
        });
      }
      return originalQuery(parameters);
    };
  } catch (_) {}

  // 6. WebGL vendor/renderer — headless reports 'Google Inc.' / 'Google
  // SwiftShader' (software rasterizer). Real Chrome exposes the actual GPU.
  // Spoof to a plausible Intel string; the IP is presumably US/EU residential
  // so a Mac-like Intel renderer is unsurprising.
  try {
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (parameter) {
      if (parameter === 37445) return 'Intel Inc.';                 // UNMASKED_VENDOR_WEBGL
      if (parameter === 37446) return 'Intel Iris OpenGL Engine';   // UNMASKED_RENDERER_WEBGL
      return getParameter.call(this, parameter);
    };
    if (typeof WebGL2RenderingContext !== 'undefined') {
      const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function (parameter) {
        if (parameter === 37445) return 'Intel Inc.';
        if (parameter === 37446) return 'Intel Iris OpenGL Engine';
        return getParameter2.call(this, parameter);
      };
    }
  } catch (_) {}

  // 7. hardwareConcurrency / deviceMemory — defaults look fine on most boxes,
  // but headless on minimal containers can report 1 or undefined. Pin to 8/8,
  // a common consumer Mac/PC.
  try {
    Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => 8, configurable: true });
    Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => 8, configurable: true });
  } catch (_) {}
})();
`;
