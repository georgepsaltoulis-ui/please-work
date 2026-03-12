/*
 * Launcher Service Worker
 * Handles: header injection per-module, module file serving, caching
 */

const CACHE_NAME = 'launcher-v1';
const moduleConfigs = new Map();
const moduleFiles = new Map(); // moduleId -> Map<relativePath, fileData>

// Install: cache the launcher shell
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(['/']))
  );
});

// Activate: claim all clients immediately
self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

// Message handler: register modules, store files
self.addEventListener('message', (event) => {
  const { type, payload } = event.data;

  switch (type) {
    case 'register-module': {
      const { id, config, basePath } = payload;
      moduleConfigs.set(id, { config, basePath });
      event.source.postMessage({ type: 'module-registered', id });
      break;
    }

    case 'store-module-file': {
      const { moduleId, path, data, contentType } = payload;
      if (!moduleFiles.has(moduleId)) {
        moduleFiles.set(moduleId, new Map());
      }
      moduleFiles.get(moduleId).set(path, { data, contentType });
      break;
    }

    case 'unregister-module': {
      const { id } = payload;
      moduleConfigs.delete(id);
      moduleFiles.delete(id);
      event.source.postMessage({ type: 'module-unregistered', id });
      break;
    }

    case 'get-modules': {
      const modules = {};
      for (const [id, val] of moduleConfigs) {
        modules[id] = val.config;
      }
      event.source.postMessage({ type: 'modules-list', modules });
      break;
    }
  }
});

// Fetch handler: intercept module requests and inject headers
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const scope = new URL(self.registration.scope).pathname;

  // Check if this request is for a module route: {scope}module/{id}/...
  const modulePath = url.pathname.startsWith(scope) 
    ? url.pathname.slice(scope.length) 
    : null;
  
  const moduleMatch = modulePath?.match(/^module\/([^/]+)(\/.*)?$/);

  if (moduleMatch) {
    const moduleId = moduleMatch[1];
    const resourcePath = moduleMatch[2] || '/index.html';

    event.respondWith(serveModuleFile(moduleId, resourcePath));
    return;
  }

  // For everything else, serve from cache or network
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});

async function serveModuleFile(moduleId, resourcePath) {
  const moduleConfig = moduleConfigs.get(moduleId);
  if (!moduleConfig) {
    return new Response('Module not found', { status: 404 });
  }

  // Normalize path
  let filePath = resourcePath;
  if (filePath === '/' || filePath === '') {
    filePath = '/' + (moduleConfig.config.entry || 'index.html');
  }
  // Remove leading slash for map lookup
  const lookupPath = filePath.startsWith('/') ? filePath.slice(1) : filePath;

  // Try to serve from stored module files
  const files = moduleFiles.get(moduleId);
  if (!files || !files.has(lookupPath)) {
    return new Response(`File not found: ${lookupPath}`, { status: 404 });
  }

  const fileData = files.get(lookupPath);

  // Build headers from module manifest
  const headers = new Headers({
    'Content-Type': fileData.contentType || guessContentType(lookupPath),
  });

  // Inject module-declared headers
  if (moduleConfig.config.headers) {
    for (const [key, value] of Object.entries(moduleConfig.config.headers)) {
      headers.set(key, value);
    }
  }

  // If module requests SharedArrayBuffer support, ensure COOP/COEP
  if (moduleConfig.config.permissions?.shared_array_buffer) {
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  }

  return new Response(fileData.data, {
    status: 200,
    headers,
  });
}

function guessContentType(path) {
  const ext = path.split('.').pop()?.toLowerCase();
  const types = {
    html: 'text/html',
    htm: 'text/html',
    js: 'application/javascript',
    mjs: 'application/javascript',
    css: 'text/css',
    json: 'application/json',
    wasm: 'application/wasm',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    txt: 'text/plain',
    md: 'text/markdown',
    bin: 'application/octet-stream',
    dat: 'application/octet-stream',
    zip: 'application/zip',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    mp4: 'video/mp4',
    webm: 'video/webm',
    webp: 'image/webp',
  };
  return types[ext] || 'application/octet-stream';
}
