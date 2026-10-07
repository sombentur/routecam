// Routecam build: produces a distributable folder + zip.   Usage: node scripts/build.mjs
// (The extension has no third-party dependencies, so there is nothing to compile.)
import { cpSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'))).version;
const dist = join(root, 'dist'), stage = join(dist, 'Routecam ' + version);
rmSync(dist, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
// The remote-debug port file is a development aid and is not shipped.
cpSync(join(root, 'extension'), join(stage, 'com.routecam.panel'), { recursive: true, filter: (src) => !src.endsWith('.debug') });
cpSync(join(root, 'scripts', 'install.ps1'), join(stage, 'install.ps1'));
cpSync(join(root, 'scripts', 'install.sh'), join(stage, 'install.sh'));
cpSync(join(root, 'Install Routecam.bat'), join(stage, 'Install Routecam.bat'));
cpSync(join(root, 'README.md'), join(stage, 'README.md'));
// docs, with only the one picture the README shows
cpSync(join(root, 'docs'), join(stage, 'docs'), { recursive: true, filter: (src) => !/screenshots.+.png$/.test(src) || /sample-frame-4_5s.png$/.test(src) });
if (existsSync(join(root, 'samples'))) cpSync(join(root, 'samples'), join(stage, 'samples'), { recursive: true });
const zip = join(dist, `Routecam-${version}.zip`);
if (process.platform === 'win32') {
  execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${stage}' -DestinationPath '${zip}' -Force`], { stdio: 'inherit' });
} else {
  execFileSync('zip', ['-qr', zip, '.'], { cwd: dist, stdio: 'inherit' });
}
console.log('Package: ' + zip);
