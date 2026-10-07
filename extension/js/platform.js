/*
 * Routecam - platform bridge.
 * Wraps the two environments the panel can run in:
 *   1. CEP inside After Effects (evalScript + Node.js for files) -> full functionality
 *   2. A plain browser (npm run preview)                          -> editor and preview only
 * Nothing else in the panel touches __adobe_cep__ or Node directly.
 */
(function () {
  'use strict';
  var RC = window.RC = window.RC || {};
  var cep = window.__adobe_cep__ || null;
  var nodeRequire = window.__rcNodeRequire || null;
  var fs = null, path = null, os = null;
  if (nodeRequire) {
    try { fs = nodeRequire('fs'); path = nodeRequire('path'); os = nodeRequire('os'); }
    catch (e) { nodeRequire = null; }
  }
  var hasNode = !!(fs && path && os);

  function asciiJson(value) {
    return JSON.stringify(value).replace(/[\u007f-￿]/g, function (c) {
      return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4);
    });
  }

  function evalScript(script) {
    return new Promise(function (resolve, reject) {
      if (!cep) { reject(new Error('Not connected to After Effects. Open this panel from Window > Extensions inside After Effects.')); return; }
      cep.evalScript(script, function (res) { resolve(res); });
    });
  }

  var tmpCounter = 0, queue = Promise.resolve();
  /** Call a RoutecamHost function in After Effects. Calls run one at a time, in order. */
  function host(fn, args) {
    var run = function () {
      var json = asciiJson(args || {}), script, tmp = null;
      if (json.length > 200000 && hasNode) {
        tmp = path.join(os.tmpdir(), 'routecam-args-' + Date.now() + '-' + (tmpCounter++) + '.json');
        fs.writeFileSync(tmp, json, 'utf8');
        script = 'RoutecamHost.invokeFile(' + asciiJson(fn) + ',' + asciiJson(tmp) + ')';
      } else {
        script = 'RoutecamHost.invoke(' + asciiJson(fn) + ',' + asciiJson(json) + ')';
      }
      return evalScript(script).then(function (res) {
        if (tmp) { try { fs.unlinkSync(tmp); } catch (e) {} }
        if (typeof res !== 'string' || res === 'EvalScript error.' || res === '') {
          throw new Error('After Effects did not accept the command (' + fn + '). If this keeps happening, close and reopen the panel.');
        }
        var out;
        try { out = JSON.parse(res); } catch (e) { throw new Error('Unexpected reply from After Effects: ' + String(res).slice(0, 200)); }
        if (!out.ok) { throw new Error(out.error || 'After Effects reported an error.'); }
        return out.result;
      });
    };
    var p = queue.then(run, run);
    queue = p.catch(function () {});
    return p;
  }

  /* ----------------------------------------------------------- storage */

  var dataDir = hasNode ? path.join(os.homedir(), 'Documents', 'Routecam') : null;

  function readJSON(name, fallback) {
    try {
      if (hasNode) {
        var file = path.join(dataDir, name);
        return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
      }
      var raw = window.localStorage.getItem('routecam:' + name);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function writeJSON(name, value) {
    try {
      if (hasNode) { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(path.join(dataDir, name), JSON.stringify(value, null, 2), 'utf8'); }
      else { window.localStorage.setItem('routecam:' + name, JSON.stringify(value)); }
      return true;
    } catch (e) { return false; }
  }
  function tempFile(name) { return hasNode ? path.join(os.tmpdir(), name) : null; }
  function fileUrl(file) { return 'file:///' + String(file).replace(/\\/g, '/').replace(/^\/+/, '') + '?t=' + Date.now(); }
  function fileExists(file) { try { return hasNode && fs.existsSync(file) && fs.statSync(file).size > 0; } catch (e) { return false; } }

  /**
   * Tell After Effects which keys the panel handles itself.  Without this the
   * host application swallows them (Ctrl+Z would undo in After Effects rather
   * than in the path editor while the editor has focus).
   */
  function claimKeys(list) {
    if (!cep || !cep.registerKeyEventsInterest) { return; }
    try { cep.registerKeyEventsInterest(JSON.stringify(list)); } catch (e) {}
  }

  RC.platform = {
    inAE: !!cep, hasNode: hasNode, host: host, evalScript: evalScript, dataDir: dataDir,
    readJSON: readJSON, writeJSON: writeJSON, tempFile: tempFile, fileUrl: fileUrl, fileExists: fileExists, claimKeys: claimKeys
  };
})();
