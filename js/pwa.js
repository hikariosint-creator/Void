/* ===== VOID — PWA (этап 7) =====
   - регистрирует Service Worker (только в защищённом контексте);
   - показывает в «Настройках» блок «Приложение»: режим запуска, состояние сети,
     честную проверку офлайн-готовности, кнопку установки, принудительное обновление файлов;
   - ничего не отправляет в сеть, кроме загрузки собственных файлов приложения. */

(function () {
  'use strict';

  const VOID = window.VOID = window.VOID || {};
  const ui = VOID.ui;
  const el = ui.el;
  const view = document.getElementById('view-settings');

  const SW_URL = 'sw.js';
  const hadController = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
  let deferredPrompt = null;
  let registerError = '';
  const vals = {};

  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
      window.navigator.standalone === true;
  }

  /* ---------- Регистрация Service Worker ---------- */
  function register() {
    if (!('serviceWorker' in navigator)) { registerError = 'Браузер не поддерживает Service Worker.'; return; }
    if (!window.isSecureContext) { registerError = 'Нужен защищённый адрес (HTTPS).'; return; }
    navigator.serviceWorker.register(SW_URL).then(function (reg) {
      reg.addEventListener('updatefound', function () { refresh(); });
    }).catch(function (err) {
      console.error('SW register error:', err);
      registerError = 'Не удалось зарегистрировать: ' + (err && err.message ? err.message : 'ошибка');
      refresh();
    });
  }

  // Новая версия приняла управление: сообщаем только если раньше уже было управление
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (hadController && VOID.toast) VOID.toast('Файлы приложения обновлены. Перезапустите VOID, чтобы применить.', 'info', 5000);
      refresh();
    });
  }

  /* ---------- Вопрос к Service Worker ---------- */
  function askWorker(worker, message) {
    return new Promise(function (resolve, reject) {
      const channel = new MessageChannel();
      const timer = setTimeout(function () { reject(new Error('timeout')); }, 3000);
      channel.port1.onmessage = function (e) { clearTimeout(timer); resolve(e.data); };
      worker.postMessage(message, [channel.port2]);
    });
  }

  async function checkOffline() {
    if (registerError) return { ok: false, text: registerError };
    if (!('serviceWorker' in navigator)) return { ok: false, text: 'не поддерживается' };
    let reg = null;
    try { reg = await navigator.serviceWorker.getRegistration(); } catch (_) { /* ниже */ }
    if (!reg) return { ok: false, text: 'ещё не установлен (обновите страницу)' };
    if (!reg.active) return { ok: false, text: 'устанавливается…' };
    try {
      const r = await askWorker(reg.active, { type: 'CHECK' });
      if (!r || !Array.isArray(r.missing)) return { ok: false, text: 'нет ответа' };
      if (r.missing.length === 0) return { ok: true, text: 'готов · файлов в кэше: ' + r.total };
      const list = r.missing.slice(0, 4).join(', ') + (r.missing.length > 4 ? '…' : '');
      return { ok: false, text: 'не хватает файлов: ' + list };
    } catch (_) {
      return { ok: false, text: 'нет ответа от Service Worker' };
    }
  }

  /* ---------- Блок «Приложение» в Настройках ---------- */
  function kv(label, key) {
    const v = el('span', { text: '—' });
    vals[key] = v;
    return el('div', { class: 'set-kv' }, [el('span', { text: label }), v]);
  }

  const installBtn = el('button', { class: 'btn btn--primary btn--block', type: 'button',
    text: 'Установить VOID как приложение', hidden: '' });
  const installHint = el('p', { class: 'set-hint' });
  const recheckBtn = el('button', { class: 'btn btn--block', type: 'button', text: 'Проверить офлайн-готовность' });
  const updateBtn = el('button', { class: 'btn btn--block', type: 'button', text: 'Обновить файлы приложения' });
  const note = el('p', { class: 'set-hint',
    text: '«Обновить файлы» очищает только сохранённые файлы программы и загружает их заново. ' +
          'Ваши записи и пароль не затрагиваются.' });

  const panel = el('section', { class: 'set-group' }, [
    el('h2', { class: 'section-title', text: 'Приложение' }),
    el('div', { class: 'set-panel' }, [
      kv('Режим', 'mode'),
      kv('Сеть', 'net'),
      kv('Офлайн-режим', 'offline'),
      installBtn,
      installHint,
      recheckBtn,
      updateBtn,
      note
    ])
  ]);

  // Вставляем перед «Опасной зоной» (последний блок, созданный settings.js)
  const groups = view.querySelectorAll(':scope > .set-group');
  if (groups.length) view.insertBefore(panel, groups[groups.length - 1]);
  else view.appendChild(panel);

  async function refresh() {
    vals.mode.textContent = isStandalone() ? 'установлено как приложение' : 'открыто в браузере';
    vals.net.textContent = navigator.onLine ? 'есть соединение' : 'нет сети (работаем офлайн)';
    installBtn.hidden = !deferredPrompt;
    if (isStandalone()) installHint.textContent = '';
    else if (!deferredPrompt) {
      installHint.textContent = 'Если кнопки установки нет: меню Chrome (три точки) → «Установить приложение» ' +
        'или «Добавить на главный экран».';
    } else installHint.textContent = '';
    vals.offline.textContent = 'проверяю…';
    const r = await checkOffline();
    vals.offline.textContent = r.text;
  }

  installBtn.addEventListener('click', async function () {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    try { await deferredPrompt.userChoice; } catch (_) { /* пользователь закрыл окно */ }
    deferredPrompt = null;
    refresh();
  });

  recheckBtn.addEventListener('click', refresh);

  updateBtn.addEventListener('click', async function () {
    const ok = await ui.confirm({
      title: 'Обновить файлы приложения?',
      text: 'Сохранённые файлы программы будут удалены и загружены заново, VOID перезапустится. Нужен интернет. Записи и пароль не затрагиваются.',
      confirmText: 'Обновить'
    });
    if (!ok) return;
    if (!navigator.onLine) { VOID.toast('Нет сети: обновление невозможно', 'error'); return; }
    updateBtn.disabled = true;
    try {
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.filter(function (k) { return k.indexOf('void-app-') === 0; })
          .map(function (k) { return caches.delete(k); }));
      }
      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) await reg.unregister();
      }
      location.reload();
    } catch (err) {
      console.error('Cache refresh error:', err);
      VOID.toast('Не удалось обновить файлы', 'error');
      updateBtn.disabled = false;
    }
  });

  /* ---------- События браузера ---------- */
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();       // показываем свою кнопку вместо автоматического окна
    deferredPrompt = e;
    refresh();
  });

  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    if (VOID.toast) VOID.toast('VOID установлен');
    refresh();
  });

  window.addEventListener('offline', function () {
    if (VOID.toast) VOID.toast('Нет сети. VOID продолжает работать офлайн.', 'info');
    refresh();
  });
  window.addEventListener('online', function () {
    if (VOID.toast) VOID.toast('Сеть появилась.', 'info');
    refresh();
  });

  window.addEventListener('hashchange', function () { if (location.hash === '#settings') refresh(); });
  document.addEventListener('void:unlock', refresh);

  // В установленном приложении просим постоянное хранилище, чтобы браузер не стирал данные
  if (isStandalone() && navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(function () { /* не критично */ });
  }

  window.addEventListener('load', register);
  refresh();
})();