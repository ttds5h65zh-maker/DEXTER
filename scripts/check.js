// Syntax-check every JavaScript file (server, web, tests, scripts).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'data', '.git'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (p.endsWith('.js')) files.push(p);
  }
};
for (const d of ['server', 'web', 'test', 'scripts']) walk(path.join(root, d));
let bad = 0;
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (err) { bad++; console.error(`✗ ${path.relative(root, f)}\n${err.stderr}`); }
}
console.log(`${files.length - bad}/${files.length} files OK`);
process.exit(bad ? 1 : 0);
