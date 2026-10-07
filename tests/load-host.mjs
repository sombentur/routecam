// Reloads host/index.jsx into the running After Effects and reports any
// ExtendScript load error with its line number (node --check cannot catch
// ExtendScript-only problems).
import { Panel, ROOT } from './lib/ae-driver.mjs';
import { join } from 'node:path';

const p = await Panel.connect();
const f = join(ROOT, 'extension', 'host', 'index.jsx').split('\\').join('/');
console.log(await p.jsx(`var __rcLoad; try { $.evalFile(${JSON.stringify(f)}); __rcLoad = "host loaded ok, " + RoutecamHost.version; } catch (e) { __rcLoad = "HOST ERR line " + e.line + ": " + e.message; } __rcLoad;`));
p.close();
process.exit(0);
