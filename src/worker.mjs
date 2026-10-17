// @body:organ=brain role="Cloudflare Workers entrypoint: fetch → handleRequest, cron → catalog refresh + probe"
import { handleRequest } from './server.mjs';
import { refresh, getState as getCatalog } from './catalog.mjs';
import { runOnce as probeOnce } from './probe.mjs';
import { setDashboardHtml, setDashboardAsset } from './dashboardAssets.mjs';
import { bootConfig } from './workerConfig.mjs';
import { logger } from './util/log.mjs';
import { setRuntimePlatform } from './runtime.mjs';
import dashboardHtml from '../web/dashboard.html?raw';
import dashboardCss from '../web/dashboard.css?raw';
import dashboardJs from '../web/dashboard.js?raw';
import dashboardModelsJs from '../web/dashboard-models.js?raw';
import dashboardPlaygroundJs from '../web/dashboard-playground.js?raw';
import dashboardPagesJs from '../web/dashboard-pages.js?raw';
import dashboardAnalyticsJs from '../web/dashboard-analytics.js?raw';
import dashboardSettingsJs from '../web/dashboard-settings.js?raw';

setDashboardHtml(dashboardHtml);
setDashboardAsset('/dashboard.css', dashboardCss);
setDashboardAsset('/dashboard.js', dashboardJs);
setDashboardAsset('/dashboard-models.js', dashboardModelsJs);
setDashboardAsset('/dashboard-playground.js', dashboardPlaygroundJs);
setDashboardAsset('/dashboard-pages.js', dashboardPagesJs);
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

export default {
  async fetch(request, env, _ctx) {
    try {
      const { cfg } = await ensureBoot(env);
      return await handleRequest(request, cfg);
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
      ctx.waitUntil(
        refresh(cfg)
          .then(() => probeOnce(cfg))
          .catch((err) => logger.error('worker cron failed', { error: err.message })),
      );
    } catch (err) {
      logger.error('worker cron boot failed', { error: err.message });
    }
  },
};
