/*
 * Launcher Service Worker v2
 * 
 * Fully stateless — reads everything from IndexedDB on each request.
 * Can be killed/restarted by the browser at any time without data loss.
 * The page writes to IndexedDB; this SW only reads.
 */

const DB_NAME = 'sandbox-launcher';
const DB_VERSION = 1;

// ── Install: skip waiting, no caching needed ──
self.addEventListener('install', () => self.skipWaiting());

// ── Activate: claim all clients immediately ──
self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

// ── IndexedDB helpers ──

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('modules')) {
        db.createObjectStore('modules');
      }
      if (!db.objectStoreNames.contains('files')) {
        db.createObjectStore('files');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbGet(storeName, key) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  }));
}

// ── Fetch handler ──

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const scope = new URL(self.registration.scope).pathname;

  // Only handle requests within our scope
  if (!url.pathname.startsWith(scope)) return;

  // Strip scope prefix to get the relative path
  const relativePath = url.pathname.slice(scope.length);

  // Check if this is a module route: module/{id}/...
  const moduleMatch = relativePath.match(/^module\/([^/]+)(\/.*)?$/);

  if (moduleMatch) {
    event.respondWith(serveModule(moduleMatch[1], moduleMatch[2] || '/'));
    return;
  }

  // Everything else: network only (let GitHub Pages serve it)
  // Don't cache — avoids stale SW issues during development
});

async function serveModule(moduleId, resourcePath) {
  try {
    // Read module config from IndexedDB
    const config = await dbGet('modules', moduleId);
    if (!config) {
      return new Response('Module not found. Is the launcher unlocked?', {
        status: 404,
        headers: { 'Content-Type': 'text/plain' }
      });
    }

    // Normalize path
    let filePath = resourcePath;
    if (filePath === '/' || filePath === '') {
      filePath = config.entry || 'index.html';
    }
    if (filePath.startsWith('/')) {
      filePath = filePath.slice(1);
    }

    // Read file from IndexedDB
    const fileKey = moduleId + '/' + filePath;
    const fileData = await dbGet('files', fileKey);
    if (!fileData) {
      return new Response('File not found: ' + filePath, {
        status: 404,
        headers: { 'Content-Type': 'text/plain' }
      });
    }

    // Build response headers
    const headers = new Headers({
      'Content-Type': fileData.contentType || guessContentType(filePath),
    });

    // Inject headers from module config
    if (config.headers) {
      for (const [key, value] of Object.entries(config.headers)) {
        headers.set(key, value);
      }
    }

    // If module needs SharedArrayBuffer, force COOP/COEP
    if (config.permissions?.shared_array_buffer) {
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    }

    return new Response(fileData.data, { status: 200, headers });

  } catch (err) {
    return new Response('Internal error: ' + err.message, {
      status: 500,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}

function guessContentType(path) {
  const ext = path.split('.').pop()?.toLowerCase();
  const types = {
    html: 'text/html', htm: 'text/html',
    js: 'application/javascript', mjs: 'application/javascript',
    css: 'text/css', json: 'application/json',
    wasm: 'application/wasm',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', svg: 'image/svg+xml', ico: 'image/x-icon',
    webp: 'image/webp',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
    txt: 'text/plain', md: 'text/markdown',
    bin: 'application/octet-stream', dat: 'application/octet-stream',
    zip: 'application/zip',
    mp3: 'audio/mpeg', wav: 'audio/wav',
    mp4: 'video/mp4', webm: 'video/webm',
  };
  return types[ext] || 'application/octet-stream';
}
