/* ===== VOID — Service Worker (этап 7) =====
   Задача: чтобы приложение открывалось без интернета.

   Стратегия «сеть, затем кэш»:
   - онлайн: берём свежий файл с сервера (с проверкой актуальности) и обновляем кэш;
   - сеть не отвечает 4 секунды или её нет: отдаём сохранённую копию.

   Безопасность и приватность:
   - работает только с файлами САМОГО приложения (тот же адрес), чужие адреса не трогает;
   - обрабатывает только GET-запросы, ничего не отправляет;
   - личные данные в кэш не попадают: они хранятся в IndexedDB и зашифрованы.

   ВАЖНО: при добавлении нового файла в проект впишите его в список PRECACHE
   и увеличьте VERSION, тогда кэш обновится. */

'use strict';

const VERSION = '0.7.0';
const CACHE = 'void-app-v' + VERSION;
const NETWORK_TIMEOUT = 4000; // мс

// Пути указаны относительно этого файла (sw.js), поэтому работают и в подпапке сайта
const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './css/auth.css',
  './css/modules.css',
  './css/stats.css',
  './css/settings.css',
  './css/responsive.css',
  './js/crypto.js',
  './js/database.js',
  './js/auth.js',
  './js/ui.js',
  './js/collection.js',
  './js/journal.js',
  './js/archive.js',
  './js/soundscape.js',
  './js/timeline.js',
  './js/statistics.js',
  './js/search.js',
  './js/backup.js',
  './js/settings.js',
  './js/pwa.js',
  './js/app.js',
  './assets/icons/icon.svg',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-512.png',
  './assets/icons/apple-touch-icon.png'
];

/* ---------- Установка: сохраняем файлы приложения ----------
   Каждый файл загружается отдельно: если какого-то нет, остальные всё равно сохранятся,
   а страница настроек покажет, чего не хватает (см. сообщение CHECK ниже). */
self.addEventListener('install', function (event) {
  event.waitUntil((async function () {
    const cache = await caches.open(CACHE);
    await Promise.allSettled(PRECACHE.map(async function (url) {
      const res = await fetch(new Request(url, { cache: 'reload' }));
      if (!res.ok) throw new Error(url + ' -> ' + res.status);
      await cache.put(url, res);
    }));
    await self.skipWaiting(); // новая версия вступает в силу сразу
  })());
});

/* ---------- Активация: удаляем кэши старых версий ---------- */
self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(function (k) { return k.indexOf('void-app-') === 0 && k !== CACHE; })
      .map(function (k) { return caches.delete(k); }));
    await self.clients.claim(); // сразу управляем уже открытыми страницами
  })());
});

/* ---------- Запросы ---------- */
function fetchWithTimeout(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, NETWORK_TIMEOUT);
  return fetch(url, { cache: 'no-cache', credentials: 'same-origin', signal: ctrl.signal })
    .finally(function () { clearTimeout(timer); });
}

async function handle(event) {
  const req = event.request;
  const cache = await caches.open(CACHE);
  try {
    const res = await fetchWithTimeout(req.url);
    if (res && res.ok && res.type === 'basic') {
      event.waitUntil(cache.put(req, res.clone()).catch(function () { /* кэш недоступен — не страшно */ }));
    }
    return res;
  } catch (_) {
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    if (req.mode === 'navigate') {
      const page = await cache.match('./index.html');
      if (page) return page;
    }
    return new Response('VOID: нет сети и этого файла нет в кэше.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return; // чужие адреса не трогаем
  event.respondWith(handle(event));
});

/* ---------- Сообщения от страницы ----------
   CHECK: проверяет, все ли файлы из списка лежат в кэше, и отвечает списком недостающих. */
self.addEventListener('message', function (event) {
  const data = event.data;
  const port = event.ports && event.ports[0];
  if (!data || data.type !== 'CHECK' || !port) return;
  event.waitUntil((async function () {
    const cache = await caches.open(CACHE);
    const missing = [];
    for (const url of PRECACHE) {
      const hit = await cache.match(url);
      if (!hit) missing.push(url.replace(/^\.\//, '') || '/');
    }
    port.postMessage({ version: VERSION, total: PRECACHE.length, missing: missing });
  })());
});