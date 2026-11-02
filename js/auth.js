/* ===== VOID — авторизация и блокировка (этап 2) =====
   - Первый запуск: создание мастер-пароля (проверка сложности, подтверждение).
   - Из пароля + случайной соли выводится ключ (PBKDF2 -> AES-256-GCM).
   - Правильность пароля проверяется расшифровкой «проверочного блока»,
     сам пароль и ключ нигде не сохраняются.
   - Ключ живёт ТОЛЬКО в переменной sessionKey (в памяти) и обнуляется при блокировке.
   - Автоблокировка по бездействию + ручная блокировка. */

(function () {
  'use strict';

  const VOID = window.VOID = window.VOID || {};
  const $ = (sel) => document.querySelector(sel);

  const MIN_LENGTH = 10;
  const VERIFY_TEXT = 'VOID-VERIFIER-v1';
  const VERIFY_AAD = 'meta:verifier';
  const ALLOWED_AUTOLOCK = [1, 2, 5, 10, 15, 30, 60]; // минуты
  const DEFAULT_AUTOLOCK = 5;
  const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'touchstart', 'scroll', 'input'];
  const SCREENS = { loading: '#auth-loading', setup: '#auth-setup', unlock: '#auth-unlock', fatal: '#auth-fatal' };
  const LEVEL_LABELS = ['', 'Слабый', 'Приемлемый', 'Хороший', 'Сильный'];

  let sessionKey = null;      // активный ключ шифрования (только в памяти)
  let authMeta = null;        // соль, параметры и проверочный блок из IndexedDB
  let autolockMinutes = DEFAULT_AUTOLOCK;
  let lastActivity = Date.now();
  let watchTimer = null;
  let busy = false;           // идёт вычисление ключа
  let locking = false;        // идёт процесс блокировки
  let bound = false;
  let failedAttempts = 0;
  let blockedUntil = 0;

  /* ---------- Экраны ---------- */
  function setAppInert(on) {
    const app = $('#app');
    if (on) { app.setAttribute('inert', ''); app.setAttribute('aria-hidden', 'true'); }
    else { app.removeAttribute('inert'); app.removeAttribute('aria-hidden'); }
  }

  function showScreen(name, focus) {
    Object.keys(SCREENS).forEach(k => { $(SCREENS[k]).hidden = (k !== name); });
    $('#auth-screen').hidden = false;
    setAppInert(true); // содержимое приложения под экраном недоступно ни пальцу, ни скринридеру
    const target = { setup: '#setup-pw', unlock: '#unlock-pw' }[name];
    if (target && focus !== false) setTimeout(() => $(target).focus(), 60);
  }

  function hideScreen() {
    $('#auth-screen').hidden = true;
    setAppInert(false);
  }

  function showFatal(text) {
    $('#fatal-text').textContent = text +
      ' [защищённый контекст: ' + (window.isSecureContext ? 'да' : 'нет') +
      '; адрес: ' + location.origin + ']';
    showScreen('fatal');
  }

  function setError(sel, text) { $(sel).textContent = text || ''; }

  function setBusy(prefix, on, label) {
    busy = on;
    const btn = $('#' + prefix + '-submit');
    if (on) { btn.dataset.label = btn.textContent; btn.textContent = label; btn.disabled = true; }
    else { if (btn.dataset.label) btn.textContent = btn.dataset.label; btn.disabled = false; }
  }

  /* ---------- Проверка пароля ---------- */
  function checkPassword(pw) {
    const issues = [];
    if (pw.length < MIN_LENGTH) issues.push('минимум ' + MIN_LENGTH + ' символов');
    const classes = [/\p{Ll}/u, /\p{Lu}/u, /\p{Nd}/u, /[^\p{L}\p{Nd}]/u].filter(r => r.test(pw)).length;
    if (classes < 3) issues.push('нужно минимум 3 типа символов (строчные, заглавные, цифры, знаки)');
    if (new Set(pw).size < 5) issues.push('слишком мало разных символов');
    if (/password|qwerty|12345|йцукен|пароль|void/i.test(pw)) issues.push('слишком предсказуемая комбинация');
    const ok = issues.length === 0;
    let level = 0;
    if (pw.length > 0) level = !ok ? 1 : (pw.length >= 18 ? 4 : pw.length >= 14 ? 3 : 2);
    return { ok: ok, issues: issues, level: level };
  }

  function updateMeter() {
    const res = checkPassword($('#setup-pw').value);
    const bar = $('#setup-meter-bar');
    bar.style.width = (res.level * 25) + '%';
    bar.classList.toggle('is-ok', res.ok);
    $('#setup-meter-label').textContent = LEVEL_LABELS[res.level];
  }

  function togglePasswordVisibility(selectors, visible) {
    selectors.forEach(s => { $(s).type = visible ? 'text' : 'password'; });
  }

  function resetPasswordFields() {
    ['#setup-pw', '#setup-pw2', '#unlock-pw'].forEach(s => { $(s).value = ''; $(s).type = 'password'; });
    $('#setup-show').checked = false;
    $('#unlock-show').checked = false;
    $('#setup-ack').checked = false;
    updateMeter();
  }

  /** Проверка структуры служебных данных, прочитанных из базы. */
  function isValidAuthMeta(m) {
    return !!m && m.salt instanceof Uint8Array && m.salt.length >= VOID.crypto.SALT_LENGTH &&
      Number.isInteger(m.iterations) && m.verifier && m.verifier.iv && m.verifier.data;
  }

  /* ---------- Первая настройка ---------- */
  async function handleSetup(e) {
    e.preventDefault();
    if (busy) return;
    setError('#setup-error', '');

    const pw = $('#setup-pw').value;
    const pw2 = $('#setup-pw2').value;

    const check = checkPassword(pw);
    if (!check.ok) { setError('#setup-error', 'Пароль не подходит: ' + check.issues.join('; ') + '.'); return; }
    if (pw !== pw2) { setError('#setup-error', 'Пароли не совпадают.'); return; }
    if (!$('#setup-ack').checked) { setError('#setup-error', 'Подтвердите, что понимаете последствия потери пароля.'); return; }

    setBusy('setup', true, 'Создаю защищённое хранилище…');
    try {
      const salt = VOID.crypto.randomBytes(VOID.crypto.SALT_LENGTH);
      const iterations = VOID.crypto.DEFAULT_ITERATIONS;
      const key = await VOID.crypto.deriveKey(pw, salt, iterations);
      const verifier = await VOID.crypto.encrypt(key, { check: VERIFY_TEXT }, VERIFY_AAD);

      const meta = {
        version: 1,
        kdf: 'PBKDF2-SHA256',
        cipher: 'AES-256-GCM',
        iterations: iterations,
        salt: salt,
        verifier: { iv: verifier.iv, data: verifier.data },
        createdAt: Date.now()
      };
      // Сначала настройки, потом auth: наличие auth означает «хранилище создано полностью»
      await VOID.db.setMeta('settings', { autolockMinutes: DEFAULT_AUTOLOCK });
      await VOID.db.setMeta('auth', meta);
      authMeta = meta;

      resetPasswordFields();
      await finishUnlock(key);
      if (VOID.toast) VOID.toast('Хранилище создано. Данные защищены шифрованием.');
    } catch (err) {
      console.error('Setup error:', err);
      setError('#setup-error', 'Не удалось создать хранилище. Попробуйте ещё раз.');
    } finally {
      setBusy('setup', false);
    }
  }

  /* ---------- Разблокировка ---------- */
  function registerFailure() {
    failedAttempts++;
    if (failedAttempts >= 3) {
      // Пауза растёт: 1, 2, 4, 8, 16, 30 секунд. Это лишь удобство против случайного перебора;
      // реальную защиту от подбора даёт PBKDF2 и сложный пароль.
      blockedUntil = Date.now() + Math.min(30, Math.pow(2, failedAttempts - 3)) * 1000;
    }
  }

  async function handleUnlock(e) {
    e.preventDefault();
    if (busy || locking) return;
    setError('#unlock-error', '');

    const input = $('#unlock-pw');
    const pw = input.value;
    if (!pw) { setError('#unlock-error', 'Введите мастер-пароль.'); return; }

    const wait = blockedUntil - Date.now();
    if (wait > 0) {
      setError('#unlock-error', 'Слишком много попыток. Подождите ' + Math.ceil(wait / 1000) + ' с.');
      return;
    }

    setBusy('unlock', true, 'Проверка…');
    try {
      const key = await VOID.crypto.deriveKey(pw, authMeta.salt, authMeta.iterations);

      // Пароль верный, если удалось расшифровать проверочный блок
      let ok = false;
      try {
        const v = await VOID.crypto.decrypt(key, authMeta.verifier.iv, authMeta.verifier.data, VERIFY_AAD);
        ok = !!v && v.check === VERIFY_TEXT;
      } catch (_) { ok = false; }

      if (!ok) {
        registerFailure();
        const extra = blockedUntil > Date.now()
          ? ' Следующая попытка через ' + Math.ceil((blockedUntil - Date.now()) / 1000) + ' с.' : '';
        setError('#unlock-error', 'Неверный пароль.' + extra);
        input.select();
        return;
      }

      resetPasswordFields();
      await finishUnlock(key);
    } catch (err) {
      console.error('Unlock error:', err);
      setError('#unlock-error', 'Ошибка при проверке пароля. Попробуйте ещё раз.');
    } finally {
      setBusy('unlock', false);
    }
  }

  async function finishUnlock(key) {
    const settings = await VOID.db.getMeta('settings');
    autolockMinutes = (settings && ALLOWED_AUTOLOCK.includes(settings.autolockMinutes))
      ? settings.autolockMinutes : DEFAULT_AUTOLOCK;

    sessionKey = key;
    failedAttempts = 0;
    blockedUntil = 0;
    locking = false;
    lastActivity = Date.now();
    startWatch();
    hideScreen();
    document.dispatchEvent(new Event('void:unlock'));
  }

  /* ---------- Блокировка ---------- */
  /** reason: 'manual' (кнопка) или 'auto' (бездействие).
      Сначала закрываем экран, затем даём модулям до 3 секунд сохранить черновики
      (событие void:beforelock), и только после этого стираем ключ из памяти. */
  async function lock(reason) {
    if (!sessionKey || locking) return;
    locking = true;
    stopWatch();

    $('#unlock-msg').textContent = reason === 'auto' ? 'Хранилище заблокировано из-за бездействия.' : '';
    $('#unlock-pw').value = '';
    $('#unlock-pw').type = 'password';
    $('#unlock-show').checked = false;
    setError('#unlock-error', '');
    showScreen('unlock', false); // без автофокуса, чтобы клавиатура не выскакивала сама

    const tasks = [];
    document.dispatchEvent(new CustomEvent('void:beforelock', {
      detail: { waitUntil: (promise) => tasks.push(Promise.resolve(promise)) }
    }));
    await Promise.race([
      Promise.allSettled(tasks),
      new Promise(resolve => setTimeout(resolve, 3000))
    ]);

    sessionKey = null; // ссылка на ключ удалена
    locking = false;
    document.dispatchEvent(new Event('void:lock')); // модули очищают расшифрованные данные из интерфейса
  }

  /* ---------- Автоблокировка по бездействию ---------- */
  function markActivity() { lastActivity = Date.now(); }

  function checkIdle() {
    if (sessionKey && Date.now() - lastActivity >= autolockMinutes * 60000) lock('auto');
  }

  function startWatch() {
    stopWatch();
    ACTIVITY_EVENTS.forEach(ev => document.addEventListener(ev, markActivity, { capture: true, passive: true }));
    document.addEventListener('visibilitychange', checkIdle); // вернулись в приложение — проверяем сразу
    watchTimer = setInterval(checkIdle, 5000);
  }

  function stopWatch() {
    ACTIVITY_EVENTS.forEach(ev => document.removeEventListener(ev, markActivity, { capture: true }));
    document.removeEventListener('visibilitychange', checkIdle);
    if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
  }

  async function setAutolockMinutes(minutes) {
    if (!ALLOWED_AUTOLOCK.includes(minutes)) throw new Error('BAD_AUTOLOCK_VALUE');
    const current = (await VOID.db.getMeta('settings')) || {};
    await VOID.db.setMeta('settings', Object.assign({}, current, { autolockMinutes: minutes }));
    autolockMinutes = minutes;
  }

  /* ---------- Запуск ---------- */
  function bindEvents() {
    if (bound) return;
    bound = true;
    $('#setup-form').addEventListener('submit', handleSetup);
    $('#unlock-form').addEventListener('submit', handleUnlock);
    $('#setup-pw').addEventListener('input', updateMeter);
    $('#setup-show').addEventListener('change', () =>
      togglePasswordVisibility(['#setup-pw', '#setup-pw2'], $('#setup-show').checked));
    $('#unlock-show').addEventListener('change', () =>
      togglePasswordVisibility(['#unlock-pw'], $('#unlock-show').checked));
  }

  async function start() {
    bindEvents();
    showScreen('loading');

    if (!VOID.crypto.isSupported()) {
      showFatal('Web Crypto API недоступен в этом окружении. Для него нужен защищённый контекст (HTTPS или localhost).');
      return;
    }
    try {
      await VOID.db.open();
      authMeta = await VOID.db.getMeta('auth');
    } catch (err) {
      console.error('Storage error:', err);
      showFatal('Не удалось открыть локальную базу данных (IndexedDB). Возможно, браузер блокирует хранение данных или включён приватный режим.');
      return;
    }

    if (!authMeta) { showScreen('setup'); return; }
    if (!isValidAuthMeta(authMeta)) {
      showFatal('Служебные данные хранилища повреждены. Восстановить доступ можно только из резервной копии.');
      return;
    }
    showScreen('unlock');
  }

  /* ---------- Публичный интерфейс ---------- */
  VOID.auth = {
    start: start,
    lock: lock,
    isUnlocked: () => sessionKey !== null && !locking,
    // Единственный способ получить ключ: бросает ошибку, если хранилище заблокировано
    getKey: function () {
      if (!sessionKey) throw new Error('LOCKED');
      return sessionKey;
    },
    checkPassword: checkPassword,
    getAutolockMinutes: () => autolockMinutes,
    setAutolockMinutes: setAutolockMinutes
  };
  VOID.lockHandler = () => lock('manual');
})();