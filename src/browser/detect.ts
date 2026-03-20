/**
 * Anti-detection diagnostic page.
 *
 * Builds an HTML page that runs Brotector-style checks entirely offline.
 * Load via data: URL, wait for window.__detectResults to be populated,
 * then read the results from Node via page.evaluate().
 *
 * Detection techniques adapted from Brotector (MIT license):
 * https://github.com/ttlns/brotector
 */

/** Build the detection HTML page as a string. */
export function buildDetectHTML(): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>site-use anti-detection check</title>
<style>
  :root { --bg: #0f1117; --fg: #e6edf3; --pass: #3fb950; --fail: #f85149; --warn: #d29922; --card: #161b22; --border: #30363d; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, sans-serif;
         background: var(--bg); color: var(--fg); padding: 40px 24px; }
  .container { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); }
  th { color: #8b949e; font-size: 0.85rem; text-transform: uppercase; }
  .pass { color: var(--pass); }
  .fail { color: var(--fail); }
  .warn { color: var(--warn); }
  #status { margin-top: 16px; font-size: 0.9rem; color: #8b949e; }
</style>
</head>
<body>
<div class="container">
  <h1>Anti-Detection Diagnostic</h1>
  <table>
    <thead><tr><th>Check</th><th>Status</th><th>Details</th></tr></thead>
    <tbody id="results"></tbody>
  </table>
  <div id="status">Running checks...</div>
</div>
<script>
(function() {
  // ---- Results accumulator ----
  const results = [];
  function record(name, passed, detail) {
    results.push({ name: name, passed: passed, detail: detail || '' });
    const tbody = document.getElementById('results');
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td>' + name + '</td>' +
      '<td class="' + (passed ? 'pass' : 'fail') + '">' + (passed ? 'PASS' : 'FAIL') + '</td>' +
      '<td>' + (detail || '') + '</td>';
    tbody.appendChild(tr);
  }

  // ---- 1. navigator.webdriver ----
  function checkWebdriver() {
    var val = navigator.webdriver;
    record('navigator.webdriver', val === false || val === undefined,
      'value=' + val + ', type=' + typeof val);
  }

  // ---- 2. window.cdc (ChromeDriver globals) ----
  function checkWindowCdc() {
    var matches = [];
    for (var prop in window) {
      if (prop.match && prop.match(/cdc_[a-z0-9]/ig)) matches.push(prop);
    }
    record('window.cdc', matches.length === 0,
      matches.length > 0 ? 'found: ' + matches.join(', ') : 'none');
  }

  // ---- 3. Playwright globals ----
  function checkPlaywright() {
    var found = [];
    if (window.__pwInitScripts !== undefined) found.push('__pwInitScripts');
    if (window.__playwright__binding__ !== undefined) found.push('__playwright__binding__');
    record('playwright_globals', found.length === 0,
      found.length > 0 ? 'found: ' + found.join(', ') : 'none');
  }

  // ---- 4. runtime.enabled (CDP Runtime detection) ----
  function checkRuntimeEnabled() {
    return new Promise(function(resolve) {
      var stackLookupCount = 0;
      var nameLookupCount = 0;

      // Temporarily override Error.prototype.name getter to count lookups
      var origDescriptor = Object.getOwnPropertyDescriptor(Error.prototype, 'name');
      Object.defineProperty(Error.prototype, 'name', {
        configurable: true, enumerable: false,
        get: function() { nameLookupCount++; return 'Error'; }
      });

      var e = new Error();
      Object.defineProperty(e, 'stack', {
        configurable: true, enumerable: false,
        get: function() { stackLookupCount++; return ''; }
      });

      // console.debug triggers CDP Runtime to read stack + name
      var c;
      try { c = console.context('detect: '); } catch(_) { c = console; }
      c.debug(e);

      // Reset name lookup count, then test again with a fresh error
      nameLookupCount = 0;
      c.debug(new Error(''));
      var finalNameCount = nameLookupCount;

      // Restore original descriptor
      if (origDescriptor) {
        Object.defineProperty(Error.prototype, 'name', origDescriptor);
      }

      // CDP Runtime causes extra lookups: stackLookupCount > 0 or nameLookupCount >= 2
      var detected = stackLookupCount > 0 || finalNameCount >= 2;
      c.clear();
      record('runtime.enabled', !detected,
        'stackLookups=' + stackLookupCount + ', nameLookups=' + finalNameCount);
      resolve();
    });
  }

  // ---- 5. UA override (High Entropy Values) ----
  function checkHighEntropyValues() {
    return new Promise(function(resolve) {
      if (!navigator.userAgentData || !navigator.userAgentData.getHighEntropyValues) {
        record('ua_override', true, 'API not available (OK)');
        resolve();
        return;
      }
      navigator.userAgentData.getHighEntropyValues([
        'architecture', 'bitness', 'model', 'platform', 'platformVersion', 'uaFullVersion'
      ]).then(function(data) {
        var allEmpty = !data.architecture && !data.bitness && !data.model &&
                       !data.platformVersion && !data.uaFullVersion;
        record('ua_override', !allEmpty,
          allEmpty ? 'all values empty (spoofed UA)' :
          'arch=' + data.architecture + ', platform=' + data.platform);
      }).catch(function(err) {
        record('ua_override', true, 'getHighEntropyValues error: ' + err.message);
      }).finally(resolve);
    });
  }

  // ---- 6. PDF style injection ----
  function checkPdfStyle() {
    return new Promise(function(resolve) {
      // Need an actual HTTP page for iframe loading; data: URLs can't load sub-iframes reliably
      // Skip if running on data: URL
      if (location.protocol === 'data:') {
        record('pdf_style', true, 'skipped (data: URL, no iframe support)');
        resolve();
        return;
      }
      var iframe = document.createElement('iframe');
      iframe.style.cssText = 'height:0;width:0;position:absolute;opacity:0';
      iframe.src = 'about:blank';
      document.body.appendChild(iframe);
      setTimeout(function() {
        try {
          var style = iframe.contentDocument && iframe.contentDocument.querySelector('style');
          var hasStyle = style && style.textContent;
          record('pdf_style', !hasStyle,
            hasStyle ? 'injected style found' : 'clean');
        } catch(e) {
          record('pdf_style', true, 'cross-origin (OK)');
        }
        document.body.removeChild(iframe);
        resolve();
      }, 500);
    });
  }

  // ---- 7. Stack signature (puppeteer/pyppeteer/stealth in call stack) ----
  function checkStackSignature() {
    var stack;
    try { throw new Error(); } catch(e) { stack = e.stack || ''; }

    var patterns = {
      puppeteer_eval: /__puppeteer_evaluation_script__/,
      puppeteer_pptr: /pptr:evaluate/,
      pyppeteer: /__pyppeteer_evaluation_script__/,
      stealth: /newHandler\.<computed> \[as apply\]/
    };
    var found = [];
    for (var name in patterns) {
      if (patterns[name].test(stack)) found.push(name);
    }
    record('stack_signature', found.length === 0,
      found.length > 0 ? 'matched: ' + found.join(', ') : 'clean');
  }

  // ---- 8. Selenium script injection (ChromeDriver source patterns in Function.apply) ----
  function checkSeleniumInjection() {
    // Check if Function.prototype.apply has been tampered with
    var applyStr = Function.prototype.apply.toString();
    var isNative = applyStr.indexOf('[native code]') !== -1;
    // Also check for ChromeDriver globals
    var cdcFound = [];
    var cdcPatterns = ['WebDriver', 'cdc_adoQpoasnfa76pfcZLmcfl'];
    for (var i = 0; i < cdcPatterns.length; i++) {
      if (window[cdcPatterns[i]] !== undefined) cdcFound.push(cdcPatterns[i]);
    }
    var passed = isNative && cdcFound.length === 0;
    record('selenium_injection', passed,
      (!isNative ? 'Function.apply patched' : 'native') +
      (cdcFound.length > 0 ? ', globals: ' + cdcFound.join(',') : ''));
  }

  // ---- 9. Input.isTrusted ----
  // This check is triggered by Node-side mouse events. We set up the listener
  // and record results when events arrive. Node code must call page.mouse.click().
  var inputResults = { checked: false, untrusted: false, coordsLeak: false };
  function setupInputCheck() {
    var events = ['mousedown', 'mouseup', 'click', 'mousemove'];
    events.forEach(function(evt) {
      document.addEventListener(evt, function(e) {
        inputResults.checked = true;
        if (!e.isTrusted) inputResults.untrusted = true;
        if (e.pageY === e.screenY && e.pageX === e.screenX &&
            (window.outerHeight - window.innerHeight) > 1) {
          inputResults.coordsLeak = true;
        }
      });
    });
  }

  // Called after Node triggers mouse events
  function recordInputResults() {
    if (!inputResults.checked) {
      record('input.isTrusted', true, 'no events received (skipped)');
      record('input.coordsLeak', true, 'no events received (skipped)');
      return;
    }
    record('input.isTrusted', !inputResults.untrusted,
      inputResults.untrusted ? 'untrusted events detected' : 'all events trusted');
    record('input.coordsLeak', !inputResults.coordsLeak,
      inputResults.coordsLeak ? 'pageX==screenX leak detected' : 'clean');
  }

  // ---- 10. Canvas mouse visualizer ----
  function checkCanvasVisualizer() {
    // Check for a full-screen fixed canvas with pointer-events:none (used by some automation tools)
    var canvases = document.querySelectorAll('canvas');
    var suspicious = false;
    canvases.forEach(function(c) {
      var s = c.style;
      if (s.position === 'fixed' && s.pointerEvents === 'none' &&
          c.width >= window.innerWidth - 1 && c.height >= window.innerHeight - 1) {
        suspicious = true;
      }
    });
    record('canvas_visualizer', !suspicious,
      suspicious ? 'suspicious overlay canvas found' : 'none');
  }

  // ---- 11. Popup crash (window.open from iframe) ----
  function checkPopupCrash() {
    var passed = true;
    var detail = 'popup allowed';
    try {
      var f = document.createElement('iframe');
      f.src = 'about:blank';
      f.style.cssText = 'height:0;width:0;opacity:0;position:absolute';
      document.body.appendChild(f);
      try {
        var w = f.contentWindow.open('', '', 'top=9999,left=9999,width=1,height=1');
        if (w) { w.close(); }
        else { passed = false; detail = 'popup blocked'; }
      } catch(e) {
        passed = false;
        detail = 'popup error: ' + e.message;
      }
      document.body.removeChild(f);
    } catch(e) {
      detail = 'iframe error: ' + e.message;
    }
    record('popup_crash', passed, detail);
  }

  // ---- Run all checks ----
  async function runAll() {
    // Sync checks
    checkWebdriver();
    checkWindowCdc();
    checkPlaywright();
    checkStackSignature();
    checkSeleniumInjection();
    checkCanvasVisualizer();
    checkPopupCrash();

    // Async checks
    await checkRuntimeEnabled();
    await checkHighEntropyValues();
    await checkPdfStyle();

    // Set up input listener — Node code will trigger mouse events,
    // then call window.__detectRecordInput() to finalize
    setupInputCheck();

    // Expose API for Node to call after triggering events
    window.__detectRecordInput = function() {
      recordInputResults();
      window.__detectResults = results;
      document.getElementById('status').textContent =
        results.filter(function(r) { return r.passed; }).length + '/' + results.length + ' passed';
    };

    // Store partial results (without input checks) immediately
    window.__detectResults = results;
    document.getElementById('status').textContent = 'Waiting for input test...';
  }

  runAll();
})();
</script>
</body>
</html>`;
}
