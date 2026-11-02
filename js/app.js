/* ===== VOID — ядро приложения =====
   Содержит: роутер разделов, нижнюю навигацию, меню «Ещё», тосты,
   Dashboard (дата, время, приветствие, счётчики, последние записи),
   запуск системы защиты и реакцию интерфейса на блокировку/разблокировку.
   Данные Dashboard получает от модулей через VOID.providers.
   Событие void:datachange сообщает статистике и поиску, что данные изменились. */

(function () {
  'use strict';

  const ROUTES = ['dashboard', 'journal', 'archive', 'soundscape',
                  'timeline', 'statistics', 'search', 'settings'];
  const MAIN_NAV = ['dashboard', 'journal', 'archive', 'search'];

  /* Общий объект. Остальные модули уже создали его раньше, поэтому дополняем, а не перезаписываем. */
  const VOID = window.VOID = window.VOID || {};
  VOID.version = '0.7.0';
  VOID.providers = VOID.providers || {};
  VOID.lockHandler = VOID.lockHandler || null;
  VOID.navigate = navigate;
  VOID.toast = toast;
  // Разделы вызывают эту функцию после сохранения/удаления записей
  VOID.refreshDashboard = function () {
    document.dispatchEvent(new Event('void:datachange'));
    return refreshDashboard();
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function isUnlocked() {
    return !!(VOID.auth && VOID.auth.isUnlocked());
  }

  /* ---------- Роутер ---------- */
  function currentRoute() {
    const r = location.hash.replace('#', '');
    return ROUTES.includes(r) ? r : 'dashboard';
  }

  function navigate(route) {
    if (!ROUTES.includes(route)) return;
    if (location.hash === '#' + route) render(); // тот же раздел — просто обновить
    else location.hash = route;                  // hashchange вызовет render()
  }

  function render() {
    const route = currentRoute();
    $$('.view').forEach(v => { v.hidden = v.id !== 'view-' + route; });
    const view = $('#view-' + route);
    $('#topbar-title').textContent = view ? view.dataset.title : '';
    $$('.nav-btn[data-route]').forEach(b =>
      b.classList.toggle('active', b.dataset.route === route));
    $('#btn-more').classList.toggle('active', !MAIN_NAV.includes(route));
    $('#views').scrollTop = 0;
    closeSheet();
    if (route === 'dashboard') refreshDashboard();
  }

  /* ---------- Меню «Ещё» ---------- */
  function openSheet() {
    $('#sheet').hidden = false;
    $('#sheet-backdrop').hidden = false;
  }
  function closeSheet() {
    $('#sheet').hidden = true;
    $('#sheet-backdrop').hidden = true;
  }

  /* ---------- Уведомления ---------- */
  function toast(message, type = 'success', ms = 3200) {
    const el = document.createElement('div');
    el.className = 'toast' + (type === 'error' ? ' toast--error' : type === 'info' ? ' toast--info' : '');
    el.textContent = String(message); // textContent — без риска внедрения HTML
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  /* ---------- Dashboard ---------- */
  function updateClock() {
    const now = new Date();
    $('#dash-time').textContent = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    $('#dash-date').textContent = now.toLocaleDateString('ru-RU',
      { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const h = now.getHours();
    const greet = h < 5 ? 'Доброй ночи' : h < 12 ? 'Доброе утро' : h < 18 ? 'Добрый день' : 'Добрый вечер';
    $('#dash-greeting').textContent = greet + '.';
  }

  function setCount(id, value) {
    $(id).textContent = (typeof value === 'number') ? String(value) : '—';
  }

  function emptyBlock(title, text) {
    const d = document.createElement('div');
    d.className = 'empty';
    const a = document.createElement('div');
    a.className = 'empty__title';
    a.textContent = title;
    const b = document.createElement('p');
    b.className = 'empty__text';
    b.textContent = text;
    d.append(a, b);
    return d;
  }

  function renderRecent(items, available) {
    const box = $('#dash-recent');
    box.textContent = ''; // очистка без innerHTML
    if (!available) {
      box.appendChild(emptyBlock('Данные недоступны', 'Разблокируйте хранилище, чтобы увидеть записи.'));
      return;
    }
    if (!items.length) {
      box.appendChild(emptyBlock('Пока нет записей', 'Нажмите «Новая запись», чтобы начать.'));
      return;
    }
    items.forEach(it => {
      // Если у записи есть id — строка кликабельна и открывает редактор
      const row = document.createElement(it.id ? 'button' : 'div');
      row.className = 'list-item' + (it.id ? ' list-item--click' : '');
      if (it.id) {
        row.type = 'button';
        row.addEventListener('click', () => { if (VOID.journal) VOID.journal.openEditor(it.id); });
      }
      const t = document.createElement('div');
      t.className = 'list-item__title';
      t.textContent = it.title || 'Без названия';
      const m = document.createElement('div');
      m.className = 'list-item__meta';
      m.textContent = it.meta || '';
      row.append(t, m);
      box.appendChild(row);
    });
  }

  /** Убирает с экрана всё, что было расшифровано (вызывается при блокировке). */
  function clearDashboard() {
    setCount('#dash-count-entries');
    setCount('#dash-count-archive');
    setCount('#dash-count-events');
    $('#dash-recent').textContent = '';
    $('#selftest-result').textContent = '';
    closeSheet();
  }

  async function refreshDashboard() {
    updateClock();
    if (!isUnlocked()) return; // под заблокированным экраном данные не загружаем
    const p = VOID.providers;
    try {
      if (typeof p.counts === 'function') {
        const c = await p.counts();
        setCount('#dash-count-entries', c.entries);
        setCount('#dash-count-archive', c.archive);
        setCount('#dash-count-events', c.events);
      }
      if (typeof p.recent === 'function') renderRecent(await p.recent(5), true);
      else renderRecent([], false);
    } catch (err) {
      if (err && err.message === 'LOCKED') return; // заблокировались в процессе загрузки
      console.error('Dashboard error:', err);
      toast('Не удалось загрузить данные главного экрана', 'error');
    }
  }

  /* ---------- Диагностика шифрования ---------- */
  async function runSelfTest() {
    const box = $('#selftest-result');
    box.textContent = '';
    if (!isUnlocked()) { toast('Сначала разблокируйте хранилище', 'error'); return; }
    try {
      const results = await VOID.db.selfTest();
      results.forEach(r => {
        const row = document.createElement('div');
        row.className = 'test-row' + (r.ok ? '' : ' test-row--fail');
        const name = document.createElement('div');
        name.className = 'test-row__name';
        name.textContent = (r.ok ? '✓ ' : '✗ ') + r.name;
        row.appendChild(name);
        if (r.detail) {
          const d = document.createElement('div');
          d.className = 'test-row__detail';
          d.textContent = r.detail;
          row.appendChild(d);
        }
        box.appendChild(row);
      });
      const failed = results.filter(r => !r.ok).length;
      if (failed === 0) toast('Все проверки пройдены (' + results.length + ')');
      else toast('Не пройдено проверок: ' + failed, 'error');
    } catch (err) {
      console.error('Self-test error:', err);
      toast('Не удалось выполнить проверку', 'error');
    }
  }

  /* ---------- Быстрые действия ---------- */
  function handleAction(name) {
    if (name === 'new-entry') {
      // Редактор открывается поверх текущего экрана; после закрытия пользователь вернётся на главную
      if (VOID.journal) VOID.journal.newEntry();
      else toast('Модуль дневника не загружен (js/journal.js)', 'error');
    } else if (name === 'open-archive') {
      navigate('archive');
    } else if (name === 'selftest') {
      runSelfTest();
    }
  }

  function handleLock() {
    if (typeof VOID.lockHandler === 'function') VOID.lockHandler();
    else toast('Модуль защиты не загружен', 'error');
  }

  /* ---------- Инициализация ---------- */
  function init() {
    // Нижняя навигация, меню «Ещё» и быстрые действия: один обработчик на документ
    document.addEventListener('click', (e) => {
      const routeBtn = e.target.closest('[data-route]');
      if (routeBtn) { navigate(routeBtn.dataset.route); return; }
      const actionBtn = e.target.closest('[data-action]');
      if (actionBtn) handleAction(actionBtn.dataset.action);
    });
    $('#btn-more').addEventListener('click', openSheet);
    $('#sheet-backdrop').addEventListener('click', closeSheet);
    $('#btn-lock').addEventListener('click', handleLock);
    window.addEventListener('hashchange', render);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

    // Реакция интерфейса на систему защиты
    document.addEventListener('void:lock', clearDashboard);
    document.addEventListener('void:unlock', refreshDashboard);

    render();
    setInterval(updateClock, 15000); // обновление часов

    // Запуск системы защиты: покажет создание пароля или экран разблокировки
    if (VOID.auth && typeof VOID.auth.start === 'function') {
      VOID.auth.start();
    } else {
      toast('Не загружен модуль защиты (js/auth.js)', 'error', 8000);
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
