// P16 mutation audit — run once, restores in finally. Usage: node tests/mutate-p16.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const files = {
  discovery: { f: 'src/discovery.mjs', orig: readFileSync('src/discovery.mjs', 'utf8') },
  compat: { f: 'src/providers/openaiCompat.mjs', orig: readFileSync('src/providers/openaiCompat.mjs', 'utf8') },
};

function run(fileKey, label, mutate) {
  const { f, orig } = files[fileKey];
  try {
    const m = mutate(orig);
    if (m === orig) { console.error('NO MATCH for', label); process.exitCode = 1; return; }
    writeFileSync(f, m);
    try {
      execFileSync('node', ['--test', 'tests/p16.test.mjs'], { stdio: 'pipe', timeout: 60000 });
      console.log('UNEXPECTED PASS —', label, 'NOT caught');
      process.exitCode = 1;
    } catch {
      console.log('caught —', label);
    }
  } finally {
    writeFileSync(f, orig);
  }
}

run('discovery', 'mergeDiscovered neutered (discovery tests should red)', (s) =>
  s.replace("for (const d of discoverProviderKeys(cfg)[providerId] ?? []) {", 'for (const d of []) {'));

run('compat', 'prefix strip broken — upstream sees prefixed id (chat test should red)', (s) =>
  s.replace("if (prefix && modelId.startsWith(`${prefix}:`)) return modelId.slice(prefix.length + 1);", 'if (false) return modelId;'));

run('compat', 'prefix never applied to listed ids (listModelIds test should red)', (s) =>
  s.replace("const prefix = inst.prefix ? `${inst.prefix}:` : '';", "const prefix = '';"));

console.log('restored, exit', process.exitCode ?? 0);
