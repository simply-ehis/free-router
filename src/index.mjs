// @body:organ=brain role="boot: validate config → initial catalog refresh → serve → graceful shutdown"
import { loadConfig, maskKey, CONFIG_PATH } from './config.mjs';
import { refresh, startCatalogLoop, stopCatalogLoop } from './catalog.mjs';
import { startServer } from './server.mjs';
import { startProbe, stopProbe } from './probe.mjs';
import { byId } from './providers/index.mjs';
import { logger } from './util/log.mjs';

const cfg = loadConfig();

try {
  await refresh(cfg);
} catch (err) {
  logger.error('initial catalog refresh failed', { error: err.message });
}
startCatalogLoop(cfg);
startProbe(cfg);
const server = startServer(cfg);

const zenCreds = byId.zen.isEnabled(cfg) ? byId.zen.listCredentials(cfg) : [];
for (const provider of Object.values(byId)) {
  if (!provider.isEnabled?.(cfg)) continue;
  const creds = provider.listCredentials?.(cfg) ?? [];
  if (creds.length > 0) {
    logger.info('provider auto-connected', { provider: provider.id, credentials: creds.length });
  } else {
    logger.info('provider idle — no key detected (connects automatically once one appears)', {
      provider: provider.id,
      paste: 'config.json → providers.<name>.keys',
      env: `FREE_ROUTER_${provider.id.toUpperCase()}_KEYS`,
    });
  }
}
logger.info('boot complete', {
  dashboardPassword: maskKey(cfg.dashboardPassword),
  config: CONFIG_PATH,
  zenCredentials: zenCreds.length,
  strategy: cfg.selection.strategy,
  decision: cfg.decision.enabled ? cfg.decision.model : 'off',
});

function shutdown(signal) {
  logger.info('shutting down', { signal });
  stopCatalogLoop();
  stopProbe();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
