// P17 mutation audit — run once, restores in finally. Usage: node tests/mutate-p17.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const files = {
  server: { f: 'src/server.mjs', orig: readFileSync('src/server.mjs', 'utf8') },
  http: { f: 'src/util/http.mjs', orig: readFileSync('src/util/http.mjs', 'utf8') },
  security: { f: 'src/security.mjs', orig: readFileSync('src/security.mjs', 'utf8') },
  workerConfig: { f: 'src/workerConfig.mjs', orig: readFileSync('src/workerConfig.mjs', 'utf8') },
};

function run(fileKey, label, mutate) {
  const { f, orig } = files[fileKey];
  try {
    const m = mutate(orig);
    if (m === orig) { console.error('NO MATCH for', label); process.exitCode = 1; return; }
    writeFileSync(f, m);
    try {
      execFileSync('node', ['--test', 'tests/p17.test.mjs'], { stdio: 'pipe', timeout: 60000 });
      console.log('UNEXPECTED PASS —', label, 'NOT caught');
      process.exitCode = 1;
    } catch {
      console.log('caught —', label);
    }
  } finally {
    writeFileSync(f, orig);
  }
}

run('server', 'auth check removed (401 tests should red)', (s) =>
  s.replace("if (!isAuthorized(request, cfg.apiKey)) return errRes(401, 'Invalid gateway API key', 'invalid_request_error', baseHeaders);",
    'if (false) return errRes(401, "x", "x");'));

run('http', 'safeEqual always true (auth boundary gone)', (s) =>
  s.replace('export function safeEqual(a, b) {', 'export function safeEqual(a, b) {\n  if (a !== undefined) return true;'));

run('security', 'cf-connecting-ip ignored (allowlist test should red)', (s) =>
  s.replace("const cf = h.get('cf-connecting-ip');\n  if (cf) return normalizeIp(cf);", ''));

run('workerConfig', 'gateway key from binding ignored (buildConfig test should red)', (s) =>
  s.replace("if (typeof env.GATEWAY_KEY === 'string' && env.GATEWAY_KEY.length >= 8) {\n    cfg.apiKey = env.GATEWAY_KEY;\n  }", ''));

run('workerConfig', 'config never persisted to KV (bootConfig persist test should red)', (s) =>
  s.replace("if (kv) Promise.resolve(kv.put(CONFIG_PATH, JSON.stringify(secretFree, null, 2))).catch(() => {});", ''));

run('workerConfig', 'secrets NOT stripped before KV persist (persist test should red)', (s) =>
  s.replace("const secretFree = stripSecrets(cfg);", 'const secretFree = cfg;'));

console.log('restored, exit', process.exitCode ?? 0);
