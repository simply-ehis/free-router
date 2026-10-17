// P15 mutation audit — run once, restores in finally. Usage: node tests/mutate-p15.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const f = 'src/catalog.mjs';
const orig = readFileSync(f, 'utf8');

function run(label, mutate) {
  try {
    const m = mutate(orig);
    if (m === orig) { console.error('NO MATCH for', label); process.exitCode = 1; return; }
    writeFileSync(f, m);
    try {
      execFileSync('node', ['--test', 'tests/providers.test.mjs'], { stdio: 'pipe', timeout: 60000 });
      console.log('UNEXPECTED PASS —', label, 'NOT caught');
      process.exitCode = 1;
    } catch {
      console.log('caught —', label);
    }
  } finally {
    writeFileSync(f, orig);
  }
}

run('free filter removed (pool=free should red)', (s) =>
  s.replace("if (poolMode === 'free' && sources.length === 0) continue;", 'if (false) continue;'));

run('pool mode ignored, always free-filter (pool=all should red)', (s) =>
  s.replace("if (poolMode === 'free' && sources.length === 0) continue;", 'if (sources.length === 0) continue;'));

console.log('restored, exit', process.exitCode ?? 0);
