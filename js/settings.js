/* ===== VOID — Настройки (этап 6) =====
   Разделы: оформление, безопасность (автоблокировка, ручная блокировка, смена мастер-пароля),
   резервные копии (панель из backup.js), хранилище и информация, диагностика, сброс.
   Оформление хранится в служебных настройках (в них нет личных данных) и применяется при запуске. */

(function () {
  'use strict';

  const VOID = window.VOID = window.VOID || {};
  const ui = VOID.ui;
  const el = ui.el;
  const view = document.getElementById('view-settings');

  const VERIFY_AAD = 'meta:verifier';
  const VERIFY_TEXT = 'VOID-VERIFIER-v1';
  const AUTOLOCK_VALUES = [1, 2, 5, 10, 15, 30, 60];
  const RESET_WORD = 'СТЕРЕТЬ';
  const DATA_STORES = ['journal', 'archive', 'soundscape', 'timeline'];

  const THEMES = {
    graphite: { label: 'Графит', vars: {} },
    black: { label: 'Чёрный', vars: { '--bg': '#000000', '--bg2': '#070707', '--card': '#101010', '--border': '#262626' } },
    gray: { label: 'Серый', vars: { '--bg': '#141414', '--bg2': '#1c1c1c', '--card': '#242424', '--border': '#3a3a3a' } }
  };
  const ACCENTS = {
    crimson: { label: 'Бордовый', main: '#A32632', hover: '#C03945' },
    steel: { label: 'Сталь', main: '#3F6FA3', hover: '#5588BF' },
    moss: { label: 'Мох', main: '#4C8A5B', hover: '#5FA46F' },
    amber: { label: 'Янтарь', main: '#A8741F', hover: '#C48A2B' },
    violet: { label: 'Фиолет', main: '#7B4FA3', hover: '#9566BF' }
  };
  const OVERRIDDEN_VARS = ['--bg', '--bg2', '--card', '--border', '--accent', '--accent-hover'];

  let appearance = { theme: 'graphite', accent: 'crimson' };
  let busy = false;
  const info = {}; // ссылки на значения в блоке «Информация»

  /* ---------- Служебные настройки ---------- */
  async function readSettings() {
    try { return (await VOID.db.getMeta('settings')) || {}; } catch (_) { return {}; }
  }

  async function updateSettings(patch) {
    const cur = await readSettings();
    const next = Object.assign({}, cur, patch);
    await VOID.db.setMeta('settings', next);
    return next;
  }

  /* ---------- Оформление ---------- */
  function has(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }

  function sanitizeAppearance(a) {
    const out = { theme: 'graphite', accent: 'crimson' };
    if (a && typeof a === 'object') {
      if (typeof a.theme === 'string' && has(THEMES, a.theme)) out.theme = a.theme;
      if (typeof a.accent === 'string' && has(ACCENTS, a.accent)) out.accent = a.accent;
    }
    return out;
  }

  function applyAppearance() {
    const root = document.documentElement;
    OVERRIDDEN_VARS.forEach(function (v) { root.style.removeProperty(v); });
    const t = THEMES[appearance.theme];
    Object.keys(t.vars).forEach(function (k) { root.style.setProperty(k, t.vars[k]); });
    if (appearance.accent !== 'crimson') {
      const a = ACCENTS[appearance.accent];
      root.style.setProperty('--accent', a.main);
      root.style.setProperty('--accent-hover', a.hover);
    }
    const m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', t.vars['--bg'] || '#080808');
  }

  /* ---------- Помощники интерфейса ---------- */
  function row(label, control) {
    return el('div', { class: 'set-row' }, [el('div', { class: 'set-label', text: label }), control]);
  }

  function group(title, children, extraClass) {
    return el('section', { class: 'set-group' }, [
      el('h2', { class: 'section-title', text: title }),
      el('div', { class: 'set-panel' + (extraClass ? ' ' + extraClass : '') }, children)
    ]);
  }

  function kvRow(label, key) {
    const v = el('span', { text: '—' });
    info[key] = v;
    return el('div', { class: 'set-kv' }, [el('span', { text: label }), v]);
  }

  function minutesLabel(m) { return m === 60 ? '1 час' : m + ' мин'; }

  function formatBytes(n) {
    if (!Number.isFinite(n) || n < 0) return '—';
    if (n < 1024) return n + ' Б';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' КБ';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' МБ';
    return (n / 1073741824).toFixed(1) + ' ГБ';
  }

  function passwordInput(autocomplete) {
    return el('input', { type: 'password', autocomplete: autocomplete, autocapitalize: 'off',
      autocorrect: 'off', spellcheck: 'false' });
  }

  function field(label, input) {
    return el('label', { class: 'field' }, [el('span', { text: label }), input]);
  }

  /* =====================================================
     Оформление
     ===================================================== */
  const themeTabs = el('div', { class: 'tabs', role: 'tablist' });
  Object.keys(THEMES).forEach(function (id) {
    themeTabs.appendChild(el('button', { class: 'tab', type: 'button', role: 'tab',
      'data-theme': id, text: THEMES[id].label }));
  });
  const swatches = el('div', { class: 'swatches' });
  Object.keys(ACCENTS).forEach(function (id) {
    const b = el('button', { class: 'swatch', type: 'button', 'data-accent': id, 'aria-label': ACCENTS[id].label });
    b.style.background = ACCENTS[id].main;
    swatches.appendChild(b);
  });

  function highlightAppearance() {
    themeTabs.querySelectorAll('.tab').forEach(function (b) {
      const on = b.dataset.theme === appearance.theme;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    swatches.querySelectorAll('.swatch').forEach(function (b) {
      const on = b.dataset.accent === appearance.accent;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  async function commitAppearance() {
    applyAppearance();
    highlightAppearance();
    try { await updateSettings({ appearance: { theme: appearance.theme, accent: appearance.accent } }); }
    catch (err) { console.error('Appearance save error:', err); VOID.toast('Не удалось сохранить оформление', 'error'); }
  }

  themeTabs.addEventListener('click', function (e) {
    const b = e.target.closest('[data-theme]');
    if (!b || !has(THEMES, b.dataset.theme) || b.dataset.theme === appearance.theme) return;
    appearance.theme = b.dataset.theme;
    commitAppearance();
  });
  swatches.addEventListener('click', function (e) {
    const b = e.target.closest('[data-accent]');
    if (!b || !has(ACCENTS, b.dataset.accent) || b.dataset.accent === appearance.accent) return;
    appearance.accent = b.dataset.accent;
    commitAppearance();
  });

  /* =====================================================
     Безопасность
     ===================================================== */
  const autolockSelect = el('select', { class: 'select', 'aria-label': 'Автоблокировка' },
    AUTOLOCK_VALUES.map(function (v) { return el('option', { value: String(v), text: minutesLabel(v) }); }));
  autolockSelect.addEventListener('change', async function () {
    const m = Number(autolockSelect.value);
    try {
      await VOID.auth.setAutolockMinutes(m);
      VOID.toast('Автоблокировка: ' + minutesLabel(m));
    } catch (err) {
      console.error('Autolock error:', err);
      VOID.toast('Не удалось сохранить настройку', 'error');
      autolockSelect.value = String(VOID.auth.getAutolockMinutes());
    }
  });

  const lockNowBtn = el('button', { class: 'btn btn--block', type: 'button' },
    [ui.icon('lock'), el('span', { text: 'Заблокировать сейчас' })]);
  lockNowBtn.addEventListener('click', function () {
    if (typeof VOID.lockHandler === 'function') VOID.lockHandler();
  });

  /* ---------- Смена мастер-пароля ---------- */
  const pwToggle = el('button', { class: 'btn btn--block', type: 'button', text: 'Сменить мастер-пароль' });
  const curPw = passwordInput('off');
  const newPw = passwordInput('new-password');
  const newPw2 = passwordInput('new-password');
  const pwShow = el('input', { type: 'checkbox' });
  const pwSubmit = el('button', { class: 'btn btn--primary btn--block', type: 'submit', text: 'Сменить пароль' });
  const pwStatus = el('div', { class: 'set-status', 'aria-live': 'polite' });
  const pwError = el('p', { class: 'set-error', role: 'alert' });
  const pwForm = el('form', { class: 'set-form', autocomplete: 'off', novalidate: '', hidden: '' }, [
    el('p', { class: 'set-hint', text: 'Все данные будут перешифрованы новым ключом. Новый пароль нигде не хранится и не восстанавливается. После смены приложение перезапустится.' }),
    field('Текущий пароль', curPw),
    field('Новый пароль', newPw),
    el('p', { class: 'field__hint', text: 'Минимум 10 символов и минимум 3 типа из 4: строчные, заглавные, цифры, знаки.' }),
    field('Повторите новый пароль', newPw2),
    el('label', { class: 'check' }, [pwShow, el('span', { text: 'Показать пароли' })]),
    pwSubmit, pwStatus, pwError
  ]);

  pwToggle.addEventListener('click', function () {
    if (busy) return;
    pwForm.hidden = !pwForm.hidden;
    if (!pwForm.hidden) setTimeout(function () { curPw.focus(); }, 60);
  });
  pwShow.addEventListener('change', function () {
    [curPw, newPw, newPw2].forEach(function (i) { i.type = pwShow.checked ? 'text' : 'password'; });
  });

  function setPwBusy(on) {
    busy = on;
    [curPw, newPw, newPw2, pwShow, pwSubmit, pwToggle].forEach(function (n) { n.disabled = on; });
  }

  /** Перешифровка всех данных новым ключом одной транзакцией. */
  async function rekey(oldPw, newPassword, progress) {
    const C = VOID.crypto;
    const meta = await VOID.db.getMeta('auth');
    if (!meta || !meta.salt || !meta.verifier) throw new Error('NO_AUTH_META');

    progress('Проверка текущего пароля…');
    const oldKey = await C.deriveKey(oldPw, meta.salt, meta.iterations);
    let ok = false;
    try {
      const v = await C.decrypt(oldKey, meta.verifier.iv, meta.verifier.data, VERIFY_AAD);
      ok = !!v && v.check === VERIFY_TEXT;
    } catch (_) { ok = false; }
    if (!ok) throw new Error('WRONG_PASSWORD');

    progress('Создание нового ключа…');
    const salt = C.randomBytes(C.SALT_LENGTH);
    const iterations = C.DEFAULT_ITERATIONS;
    const newKey = await C.deriveKey(newPassword, salt, iterations);
    const verifier = await C.encrypt(newKey, { check: VERIFY_TEXT }, VERIFY_AAD);

    progress('Перешифровка данных…');
    const writes = [];
    let skipped = 0;
    for (const store of VOID.db.STORES) {
      const rows = await VOID.db.getAllRaw(store);
      for (const raw of rows) {
        const aad = store + ':' + raw.id;
        let value;
        try { value = await C.decrypt(oldKey, raw.iv, raw.data, aad); }
        catch (_) { skipped++; continue; } // уже повреждённые записи остаются как есть
        const enc = await C.encrypt(newKey, value, aad);
        writes.push({ store: store, record: { id: raw.id, iv: enc.iv, data: enc.data } });
      }
    }

    progress('Сохранение…');
    const db = await VOID.db.open();
    const newMeta = Object.assign({}, meta, {
      salt: salt, iterations: iterations,
      verifier: { iv: verifier.iv, data: verifier.data },
      passwordChangedAt: Date.now()
    });
    await new Promise(function (resolve, reject) {
      const t = db.transaction(VOID.db.STORES.concat(['meta']), 'readwrite');
      t.oncomplete = function () { resolve(); };
      t.onerror = function () { reject(t.error || new Error('IDB_TX_ERROR')); };
      t.onabort = function () { reject(t.error || new Error('IDB_TX_ABORTED')); };
      try {
        writes.forEach(function (w) { t.objectStore(w.store).put(w.record); });
        t.objectStore('meta').put({ key: 'auth', value: newMeta });
      } catch (err) {
        try { t.abort(); } catch (_) { /* уже завершена */ }
        reject(err);
      }
    });
    return { count: writes.length, skipped: skipped };
  }

  pwForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    if (busy) return;
    pwError.textContent = '';
    pwStatus.textContent = '';
    if (!VOID.auth.isUnlocked()) return;

    if (!curPw.value) { pwError.textContent = 'Введите текущий пароль.'; return; }
    const check = VOID.auth.checkPassword(newPw.value);
    if (!check.ok) { pwError.textContent = 'Новый пароль не подходит: ' + check.issues.join('; ') + '.'; return; }
    if (newPw.value !== newPw2.value) { pwError.textContent = 'Новые пароли не совпадают.'; return; }
    if (newPw.value === curPw.value) { pwError.textContent = 'Новый пароль совпадает со старым.'; return; }

    const ok = await ui.confirm({
      title: 'Сменить мастер-пароль?',
      text: 'Все данные будут перешифрованы. Не закрывайте приложение до конца. Новый пароль восстановить невозможно: потеряв его, вы потеряете данные.',
      confirmText: 'Сменить'
    });
    if (!ok) return;

    setPwBusy(true);
    try {
      const res = await rekey(curPw.value, newPw.value, function (t) { pwStatus.textContent = t; });
      curPw.value = ''; newPw.value = ''; newPw2.value = '';
      pwStatus.textContent = 'Пароль изменён. Перезапуск…';
      VOID.toast('Пароль изменён' + (res.skipped ? ' (повреждённых записей пропущено: ' + res.skipped + ')' : ''));
      setTimeout(function () { location.reload(); }, 1400); // новый вход с новым паролем
    } catch (err) {
      pwStatus.textContent = '';
      if (err && err.message === 'WRONG_PASSWORD') pwError.textContent = 'Текущий пароль неверный.';
      else {
        console.error('Rekey error:', err);
        pwError.textContent = 'Не удалось сменить пароль. Данные не изменены.';
      }
      setPwBusy(false);
    }
  });

  /* =====================================================
     Сброс приложения (общий блок для настроек и экрана входа)
     ===================================================== */
  function buildResetPanel() {
    const input = el('input', { class: 'input', type: 'text', placeholder: 'Введите слово ' + RESET_WORD,
      autocomplete: 'off', autocapitalize: 'characters', autocorrect: 'off', spellcheck: 'false',
      'aria-label': 'Подтверждение сброса' });
    const btn = el('button', { class: 'btn btn--danger btn--block', type: 'button',
      text: 'Стереть все данные', disabled: '' });
    const err = el('p', { class: 'set-error', role: 'alert' });

    input.addEventListener('input', function () {
      btn.disabled = input.value.trim().toUpperCase() !== RESET_WORD;
    });
    btn.addEventListener('click', async function () {
      if (input.value.trim().toUpperCase() !== RESET_WORD) return;
      btn.disabled = true;
      input.disabled = true;
      btn.textContent = 'Удаление…';
      err.textContent = '';
      try {
        await VOID.db.destroy();
        location.replace(location.pathname + location.search);
      } catch (e) {
        console.error('Reset error:', e);
        err.textContent = 'Не удалось удалить данные. Очистите данные сайта в настройках браузера.';
        input.disabled = false;
        btn.textContent = 'Стереть все данные';
        btn.disabled = input.value.trim().toUpperCase() !== RESET_WORD;
      }
    });

    return {
      node: el('div', { class: 'set-row' }, [input, btn, err]),
      reset: function () { input.value = ''; input.disabled = false; btn.disabled = true; btn.textContent = 'Стереть все данные'; err.textContent = ''; },
      focus: function () { setTimeout(function () { input.focus(); }, 60); }
    };
  }

  const resetToggle = el('button', { class: 'btn btn--danger btn--block', type: 'button', text: 'Сбросить приложение…' });
  const resetPanel = buildResetPanel();
  const resetBox = el('div', { class: 'set-row', hidden: '' }, [
    el('p', { class: 'set-hint', text: 'Будут безвозвратно удалены ВСЕ записи, настройки и мастер-пароль на этом устройстве. Отменить это нельзя. Сначала сделайте резервную копию.' }),
    resetPanel.node
  ]);
  resetToggle.addEventListener('click', function () {
    resetBox.hidden = !resetBox.hidden;
    if (!resetBox.hidden) resetPanel.focus();
  });

  /** Блок «Забыли пароль?» на экране входа: единственный путь, если пароль утерян. */
  function installForgotPassword() {
    const section = document.getElementById('auth-unlock');
    if (!section) return;
    const panel = buildResetPanel();
    const box = el('div', { hidden: '' }, [
      el('div', { class: 'warn', text: 'Пароль восстановить невозможно: данные зашифрованы, и ключа нет ни у кого, в том числе у приложения. Можно только стереть всё и начать заново. Если у вас есть резервная копия, её можно будет импортировать, зная её пароль.' }),
      panel.node
    ]);
    const toggle = el('button', { class: 'btn btn--ghost btn--block', type: 'button', text: 'Забыли пароль?' });
    toggle.addEventListener('click', function () {
      box.hidden = !box.hidden;
      if (!box.hidden) panel.focus();
    });
    section.appendChild(el('div', { class: 'forgot' }, [toggle, box]));
    const collapse = function () { box.hidden = true; panel.reset(); };
    document.addEventListener('void:lock', collapse);
    document.addEventListener('void:unlock', collapse);
  }

  /* =====================================================
     Информация о хранилище и приложении
     ===================================================== */
  const persistBtn = el('button', { class: 'btn btn--block', type: 'button', text: 'Защитить хранилище от очистки браузером', hidden: '' });
  persistBtn.addEventListener('click', async function () {
    try {
      const granted = await navigator.storage.persist();
      VOID.toast(granted ? 'Постоянное хранилище включено' : 'Браузер не разрешил. Установка VOID как приложения повышает шансы.',
        granted ? 'success' : 'info');
    } catch (err) { console.error(err); }
    refreshPersist();
  });

  async function refreshPersist() {
    if (!(navigator.storage && navigator.storage.persisted)) {
      info.persist.textContent = 'не поддерживается';
      persistBtn.hidden = true;
      return;
    }
    let p = false;
    try { p = await navigator.storage.persisted(); } catch (_) { /* не критично */ }
    info.persist.textContent = p ? 'включено' : 'выключено';
    persistBtn.hidden = p || !navigator.storage.persist;
  }

  async function refreshInfo() {
    info.version.textContent = String(VOID.version || '—');
    info.format.textContent = VOID.backup ? String(VOID.backup.FORMAT_VERSION) : '—';
    try {
      const meta = await VOID.db.getMeta('auth');
      if (meta) {
        info.kdf.textContent = 'PBKDF2-SHA256 · ' + Number(meta.iterations).toLocaleString('ru-RU') + ' итераций';
        info.created.textContent = ui.formatDate(meta.createdAt);
      }
      let total = 0;
      for (const s of DATA_STORES) total += await VOID.db.countRaw(s);
      info.records.textContent = String(total);
    } catch (err) { console.error('Info error:', err); }
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const est = await navigator.storage.estimate();
        info.usage.textContent = formatBytes(est.usage || 0) + (est.quota ? ' из ' + formatBytes(est.quota) : '');
      } catch (_) { info.usage.textContent = 'недоступно'; }
    } else { info.usage.textContent = 'недоступно'; }
    refreshPersist();
  }

  /* =====================================================
     Сборка раздела
     ===================================================== */
  const backupPanel = VOID.backup ? VOID.backup.buildPanel() : null;

  view.textContent = '';
  view.appendChild(group('Оформление', [
    row('Тема', themeTabs),
    row('Акцентный цвет', swatches)
  ]));
  view.appendChild(group('Безопасность', [
    row('Автоблокировка через', autolockSelect),
    el('p', { class: 'set-hint', text: 'Хранилище блокируется, если вы не касаетесь экрана. При блокировке ключ шифрования стирается из памяти.' }),
    lockNowBtn,
    pwToggle,
    pwForm
  ]));
  if (backupPanel) {
    view.appendChild(el('section', { class: 'set-group' }, [
      el('h2', { class: 'section-title', text: 'Резервные копии' }),
      backupPanel.node
    ]));
  }
  view.appendChild(group('Хранилище', [
    kvRow('Записей всего', 'records'),
    kvRow('Занято на устройстве', 'usage'),
    kvRow('Постоянное хранилище', 'persist'),
    persistBtn
  ]));
  view.appendChild(group('О приложении', [
    kvRow('Версия VOID', 'version'),
    kvRow('Формат резервной копии', 'format'),
    kvRow('Шифрование', 'cipher'),
    kvRow('Получение ключа', 'kdf'),
    kvRow('Хранилище создано', 'created'),
    el('p', { class: 'set-hint', text: 'Данные хранятся только на этом устройстве. Приложение не отправляет их никуда, не использует аналитику и рекламу.' })
  ]));
  view.appendChild(group('Диагностика', [
    el('button', { class: 'btn btn--block', type: 'button', 'data-action': 'selftest', text: 'Проверить шифрование' }),
    el('div', { id: 'selftest-result', class: 'list diag-list', 'aria-live': 'polite' })
  ]));
  view.appendChild(group('Опасная зона', [
    el('p', { class: 'set-hint', text: 'Сброс удаляет все данные без возможности восстановления.' }),
    resetToggle,
    resetBox
  ], 'set-panel--danger'));
  info.cipher.textContent = 'AES-256-GCM';

  /* =====================================================
     Обновление и события
     ===================================================== */
  async function refreshAll() {
    if (!VOID.auth || !VOID.auth.isUnlocked()) return;
    autolockSelect.value = String(VOID.auth.getAutolockMinutes());
    highlightAppearance();
    try { await refreshInfo(); } catch (err) { console.error(err); }
    if (backupPanel) backupPanel.refresh();
  }

  function clearSensitive() {
    [curPw, newPw, newPw2].forEach(function (i) { i.value = ''; i.type = 'password'; });
    pwShow.checked = false;
    pwForm.hidden = true;
    pwStatus.textContent = '';
    pwError.textContent = '';
    resetBox.hidden = true;
    resetPanel.reset();
    if (!busy) setPwBusy(false);
  }

  window.addEventListener('hashchange', function () { if (location.hash === '#settings') refreshAll(); });
  document.addEventListener('void:unlock', refreshAll);
  document.addEventListener('void:lock', clearSensitive);

  // Оформление применяем сразу при запуске, ещё до ввода пароля
  readSettings().then(function (s) {
    appearance = sanitizeAppearance(s.appearance);
    applyAppearance();
    highlightAppearance();
  });
  highlightAppearance();
  installForgotPassword();

  VOID.settings = { update: updateSettings, read: readSettings, buildResetPanel: buildResetPanel };
})();