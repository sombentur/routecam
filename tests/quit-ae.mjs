// Closes After Effects WITHOUT saving the open project. Used after test runs only.
import { Panel } from './lib/ae-driver.mjs';
const p = await Panel.connect();
try { await Promise.race([p.jsx('app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); app.quit(); "ok"'), new Promise((r) => setTimeout(r, 8000))]); } catch { /* AE is shutting down */ }
p.close(); process.exit(0);
