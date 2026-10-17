// @body:organ=face type=dashboard role="dashboard static assets: HTML shell + css/js served from disk (node) or ?raw bundle (worker), cached per process/isolate"
import path from 'node:path';
import { ROOT } from './config.mjs';
import { store } from './store.mjs';

const HTML_PATH = path.join(ROOT, 'web', 'dashboard.html');
// Static dashboard assets, served unauthenticated next to the HTML shell.
const ASSETS = {
  '/dashboard.css': { file: 'dashboard.css', type: 'text/css; charset=utf-8' },
  '/dashboard.js': { file: 'dashboard.js', type: 'text/javascript; charset=utf-8' },
  '/dashboard-models.js': { file: 'dashboard-models.js', type: 'text/javascript; charset=utf-8' },
  '/dashboard-playground.js': { file: 'dashboard-playground.js', type: 'text/javascript; charset=utf-8' },
  '/dashboard-pages.js': { file: 'dashboard-pages.js', type: 'text/javascript; charset=utf-8' },
  '/dashboard-analytics.js': { file: 'dashboard-analytics.js', type: 'text/javascript; charset=utf-8' },
  '/dashboard-settings.js': { file: 'dashboard-settings.js', type: 'text/javascript; charset=utf-8' },
};

let htmlCache = null;
const assetCache = new Map();

export function setDashboardHtml(html) {
  htmlCache = html;
}

export function serveDashboardHtml() {
  try {
    if (!htmlCache) htmlCache = store.read(HTML_PATH);
    if (!htmlCache) throw new Error('dashboard.html not found');
    return new Response(htmlCache, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  } catch (err) {
    return new Response(`dashboard unavailable: ${err.message}`, {
      status: 500,
      headers: { 'content-type': 'text/plain' },
    });
  }
}

// Worker bundles assets via ?raw imports; node reads them from disk on first request.
export function setDashboardAsset(pathname, content) {
  const asset = ASSETS[pathname];
  if (asset) assetCache.set(asset.file, content);
}

export function serveDashboardAsset(pathname) {
  const asset = ASSETS[pathname];
  if (!asset) return null;
  try {
    let content = assetCache.get(asset.file);
    if (content === undefined) {
      content = store.read(path.join(ROOT, 'web', asset.file));
      if (!content) throw new Error(`${asset.file} not found`);
      assetCache.set(asset.file, content);
    }
    return new Response(content, {
      status: 200,
      headers: { 'content-type': asset.type, 'cache-control': 'no-cache' },
    });
  } catch (err) {
    return new Response(`asset unavailable: ${err.message}`, {
      status: 500,
      headers: { 'content-type': 'text/plain' },
    });
  }
}
