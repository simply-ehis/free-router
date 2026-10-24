// @body:organ=brain role="Cloudflare Workers entrypoint: fetch → handleRequest, cron → catalog refresh + probe"
import { handleRequest } from './server.mjs';
import { refresh, getState as getCatalog } from './catalog.mjs';
import { runOnce as probeOnce, flushProbeState } from './probe.mjs';
import { setDashboardHtml, setDashboardAsset } from './dashboardAssets.mjs';
import { bootConfig, syncFromKv, drainPending, pendingWriteCount } from './workerConfig.mjs';
import { flush as flushUsage, isDirty as usageDirty } from './usage.mjs';
import { logger } from './util/log.mjs';
import { setRuntimePlatform } from './runtime.mjs';
import dashboardHtml from '../web/dashboard.html?raw';
import dashboardCss from '../web/dashboard.css?raw';
import dashboardJs from '../web/dashboard.js?raw';
import dashboardModelsJs from '../web/dashboard-models.js?raw';
import dashboardPlaygroundJs from '../web/dashboard-playground.js?raw';
import dashboardProvidersJs from '../web/dashboard-providers.js?raw';
import dashboardSecurityJs from '../web/dashboard-security.js?raw';
import dashboardAnalyticsJs from '../web/dashboard-analytics.js?raw';
import dashboardSettingsJs from '../web/dashboard-settings.js?raw';

setDashboardHtml(dashboardHtml);
setDashboardAsset('/dashboard.css', dashboardCss);
setDashboardAsset('/dashboard.js', dashboardJs);
setDashboardAsset('/dashboard-models.js', dashboardModelsJs);
setDashboardAsset('/dashboard-playground.js', dashboardPlaygroundJs);
setDashboardAsset('/dashboard-providers.js', dashboardProvidersJs);
setDashboardAsset('/dashboard-security.js', dashboardSecurityJs);
setDashboardAsset('/dashboard-analytics.js', dashboardAnalyticsJs);
setDashboardAsset('/dashboard-settings.js', dashboardSettingsJs);
setRuntimePlatform('worker');

let runtime = null; // { cfg } per isolate
let bootPromise = null;
let lastCatalogRefresh = 0;

async function ensureCatalog(cfg) {
  const cat = getCatalog();
  if (cat.models.length > 0 && Date.now() - cat.lastRefresh < 60_000) return;
  if (Date.now() - lastCatalogRefresh < 5000) return;
  lastCatalogRefresh = Date.now();
  try {
    await refresh(cfg);
  } catch (err) {
    logger.warn('worker catalog hydrate failed', { error: err.message });
  }
}

async function ensureBoot(env) {
  if (runtime) return runtime;
  if (!bootPromise) {
    bootPromise = bootConfig(env, env.DATA)
      .then(async ({ cfg }) => {
        await ensureCatalog(cfg);
        runtime = { cfg };
        logger.info('worker isolate booted', { name: cfg.name, dashboardPasswordSet: cfg.dashboardPassword?.length >= 8 });
        return runtime;
      })
      .catch((err) => {
        bootPromise = null;
        throw err;
      });
  }
  return bootPromise;
}

// Cloudflare may freeze the isolate right after the response, so anything still
// queued (KV puts, the usage ledger's debounce timer) is finished under
// ctx.waitUntil: poll until nothing is pending (max ~20s). The usage ledger's own
// 5s debounce does the flushing, so a busy router costs one KV write per 5s, not
// one per second; a single forced flush at ~8s is the safety net.
async function settleWrites() {
  let idle = 0;
  for (let i = 0; i < 20 && idle < 2; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    if (i === 8 && usageDirty()) flushUsage();
    flushProbeState({ force: true });
    await drainPending();
    idle = !usageDirty() && pendingWriteCount() === 0 ? idle + 1 : 0;
  }
}

export default {
  async fetch(request, env, ctx) {
    try {
      const { cfg } = await ensureBoot(env);
      const synced = await syncFromKv(env, env.DATA, cfg).catch(() => ({ poolChanged: false }));
      if (synced.poolChanged) await refresh(cfg).catch((err) => logger.warn('refresh after config sync failed', { error: err.message }));
      const res = await handleRequest(request, cfg);
      if (ctx?.waitUntil && (usageDirty() || pendingWriteCount() > 0 || request.method !== 'GET')) ctx.waitUntil(settleWrites());
      return res;
    } catch (err) {
      logger.error('worker fetch failed', { error: err.message });
      return new Response(
        JSON.stringify({ error: { message: 'Router unavailable — check bindings (GATEWAY_KEY, CONFIG, DATA)', type: 'server_error' } }),
        { status: 503, headers: { 'content-type': 'application/json' } },
      );
    }
  },

  async scheduled(_event, env, ctx) {
    try {
      const { cfg } = await ensureBoot(env);
      await syncFromKv(env, env.DATA, cfg, { minIntervalMs: 0 }).catch(() => null);
      ctx.waitUntil(
        refresh(cfg)
          .then(() => probeOnce(cfg))
          .then(() => { flushUsage(); flushProbeState({ force: true }); return drainPending(); })
          .catch((err) => logger.error('worker cron failed', { error: err.message })),
      );
    } catch (err) {
      logger.error('worker cron boot failed', { error: err.message });
    }
  },
};
