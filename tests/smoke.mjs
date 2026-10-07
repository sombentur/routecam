// Quick connectivity check: is the panel alive inside After Effects, and does the host script load?
import { ensurePanel, Panel, log, ROOT } from './lib/ae-driver.mjs';
import { join } from 'node:path';

const { started } = await ensurePanel();
const panel = await Panel.connect();
const f = join(ROOT, 'extension', 'host', 'index.jsx').split('\\').join('/');
log(await panel.jsx(`var __rcLoad; try { $.evalFile(${JSON.stringify(f)}); __rcLoad = "host loaded ok, " + RoutecamHost.version; } catch (e) { __rcLoad = "HOST ERR line " + e.line + ": " + e.message; } __rcLoad;`));
const info = await panel.run(async () => {
  const P = RC.platform;
  return { inAE: P.inAE, hasNode: P.hasNode, ua: navigator.userAgent, dataDir: P.dataDir, host: P.inAE ? await P.host('ping') : null,
           project: await P.evalScript('app.project.numItems + "|" + (app.project.file ? app.project.file.fsName : "unsaved")') };
});
log(JSON.stringify(info, null, 2));
await panel.screenshot(join(ROOT, 'docs', 'screenshots', 'smoke.png'));
log('started AE:', started);
panel.close();
process.exit(0);
