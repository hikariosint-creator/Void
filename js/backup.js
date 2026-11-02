/* ===== VOID — резервные копии (этап 6) =====
   Формат файла (JSON, версия 1):
   { format:"VOID-BACKUP", version:1, app, appVersion, createdAt, cipher:"AES-256-GCM",
     kdf:{ name:"PBKDF2-SHA256", iterations, salt }, verifier:{iv,data}, manifest:{iv,data},
     counts, stores:{ journal:[{id,iv,data}], archive:[...], soundscape:[...], timeline:[...] },
     checksum }

   - Записи лежат в файле в том же зашифрованном виде, что и в базе. Мастер-пароль не экспортируется.
   - checksum: SHA-256 по всему содержимому; ловит случайные повреждения файла.
   - manifest: зашифрованный список записей, заверенный ключом (AES-GCM). Вместе с шифрованием
     каждой записи он выявляет подмену, удаление и добавление записей.
   - Черновики в копию не входят.
   - Импорт: пароль копии проверяется, записи расшифровываются и сразу шифруются заново
     ключом ТЕКУЩЕГО пароля. Все проверки выполняются до записи в базу. */

(function () {
  'use strict';

  const VOID = window.VOID = window.VOID || {};
  const ui = VOID.ui;
  const el = ui.el;

  const FORMAT = 'VOID-BACKUP';
  const FORMAT_VERSION = 1;
  const STORES = ['journal', 'archive', 'soundscape', 'timeline'];
  const STORE_LABELS = { journal: 'Дневник', archive: 'Архив', soundscape: 'Soundscape', timeline: 'Хронология' };

  const MAX_FILE_BYTES = 100 * 1024 * 1024;
  const MAX_RECORDS = 200000;
  const MAX_RECORD_BYTES = 10 * 1024 * 1024;
  const MIN_ITER = 100000;
  const MAX_ITER = 5000000;
  const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
  const MANIFEST_AAD = 'backup:manifest';
  const VERIFY_AAD = 'meta:verifier';
  const VERIFY_TEXT = 'VOID-VERIFIER-v1';
  const CORRUPT = 'Файл повреждён или имеет неверный формат.';
  const RECORD_FORMS = ['запись', 'записи', 'записей'];

  /* ---------- Помощники ---------- */
  /** Ошибка с понятным пользователю текстом. */
  function fail(message) {
    const e = new Error(message);
    e.user = true;
    throw e;
  }

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

  function plural(n, forms) {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    if (a > 10 && a < 20) return forms[2];
    if (b > 1 && b < 5) return forms[1];
    if (b === 1) return forms[0];
    return forms[2];
  }

  async function sha256Hex(text) {
    const buf = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  /** Длина данных после декодирования Base64 (без самого декодирования); -1, если строка некорректна. */
  function b64Bytes(s) {
    if (typeof s !== 'string' || s.length % 4 !== 0 || !B64_RE.test(s)) return -1;
    const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
    return s.length / 4 * 3 - pad;
  }

  function checkB64(s, min, max) {
    const n = b64Bytes(s);
    if (n < min || n > max) fail(CORRUPT);
  }

  function decodeB64(s) { return VOID.crypto.fromB64(s); }

  function byId(x, y) { return x.id < y.id ? -1 : x.id > y.id ? 1 : 0; }

  /** Каноническая строка для контрольной суммы: порядок полей и записей фиксирован. */
  function canonicalPayload(b) {
    const stores = STORES.map(function (s) {
      const rows = b.stores[s].slice().sort(byId);
      return [s, rows.map(function (r) { return [r.id, r.iv, r.data]; })];
    });
    return JSON.stringify([b.format, b.version, b.kdf.name, b.kdf.iterations, b.kdf.salt, b.cipher,
      b.verifier.iv, b.verifier.data, b.manifest.iv, b.manifest.data, stores]);
  }

  function idsList(storesObj) {
    const ids = [];
    STORES.forEach(function (s) {
      storesObj[s].forEach(function (r) { ids.push(s + ':' + r.id); });
    });
    return ids.sort();
  }

  function fileName() {
    const d = new Date();
    const p = function (n) { return String(n).padStart(2, '0'); };
    return 'void-backup-' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      '-' + p(d.getHours()) + p(d.getMinutes()) + '.json';
  }

  async function saveLastBackup(count) {
    try {
      const cur = (await VOID.db.getMeta('settings')) || {};
      await VOID.db.setMeta('settings', Object.assign({}, cur, { lastBackupAt: Date.now(), lastBackupCount: count }));
    } catch (err) { console.error('Backup meta error:', err); }
  }

  /* =====================================================
     Создание копии
     ===================================================== */
  async function createBackup() {
    const C = VOID.crypto;
    const key = VOID.auth.getKey(); // бросит LOCKED, если хранилище заблокировано
    const meta = await VOID.db.getMeta('auth');
    if (!meta || !meta.salt || !meta.verifier) throw new Error('NO_AUTH_META');

    const stores = {};
    const counts = {};
    let total = 0;
    for (const s of STORES) {
      const rows = await VOID.db.getAllRaw(s);
      stores[s] = rows.map(function (r) {
        return { id: r.id, iv: C.toB64(r.iv), data: C.toB64(r.data) };
      }).sort(byId);
      counts[s] = stores[s].length;
      total += counts[s];
    }

    const manifestValue = { createdAt: Date.now(), counts: counts, idsDigest: await sha256Hex(idsList(stores).join('\n')) };
    const m = await C.encrypt(key, manifestValue, MANIFEST_AAD);

    const backup = {
      format: FORMAT,
      version: FORMAT_VERSION,
      app: 'VOID',
      appVersion: String(VOID.version || ''),
      createdAt: new Date().toISOString(),
      cipher: 'AES-256-GCM',
      kdf: { name: 'PBKDF2-SHA256', iterations: meta.iterations, salt: C.toB64(meta.salt) },
      verifier: { iv: C.toB64(meta.verifier.iv), data: C.toB64(meta.verifier.data) },
      manifest: { iv: C.toB64(m.iv), data: C.toB64(m.data) },
      counts: counts,
      stores: stores
    };
    backup.checksum = await sha256Hex(canonicalPayload(backup));
    return { backup: backup, total: total };
  }

  async function shareFile(blob, name) {
    if (!navigator.share || !navigator.canShare) throw new Error('SHARE_UNSUPPORTED');
    const types = ['application/json', 'text/plain'];
    for (const type of types) {
      const file = new File([blob], type === 'text/plain' ? name + '.txt' : name, { type: type });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'VOID backup' });
        return;
      }
    }
    throw new Error('SHARE_UNSUPPORTED');
  }

  /** mode: 'download' (скачать файл) или 'share' (системное меню «Поделиться»). Возвращает число записей. */
  async function exportBackup(mode) {
    const res = await createBackup();
    const name = fileName();
    const blob = new Blob([JSON.stringify(res.backup)], { type: 'application/json' });
    if (mode === 'share') {
      await shareFile(blob, name);
    } else {
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: name });
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 4000);
    }
    await saveLastBackup(res.total);
    return res.total;
  }

  /* =====================================================
     Проверка файла
     ===================================================== */
  function validateStructure(b) {
    if (!isObj(b) || b.format !== FORMAT) fail('Это не резервная копия VOID.');
    if (!Number.isInteger(b.version) || b.version < 1) fail(CORRUPT);
    if (b.version > FORMAT_VERSION) fail('Копия создана более новой версией VOID. Обновите приложение и повторите.');
    if (b.cipher !== 'AES-256-GCM') fail('Неподдерживаемый алгоритм шифрования в файле.');
    if (!isObj(b.kdf) || b.kdf.name !== 'PBKDF2-SHA256' || !Number.isInteger(b.kdf.iterations) ||
        b.kdf.iterations < MIN_ITER || b.kdf.iterations > MAX_ITER) fail(CORRUPT);
    checkB64(b.kdf.salt, 16, 64);
    [b.verifier, b.manifest].forEach(function (p) {
      if (!isObj(p)) fail(CORRUPT);
      checkB64(p.iv, 12, 12);
      checkB64(p.data, 16, 8192);
    });
    if (!isObj(b.stores)) fail(CORRUPT);
    if (typeof b.checksum !== 'string' || !/^[0-9a-f]{64}$/.test(b.checksum)) fail(CORRUPT);

    let total = 0;
    STORES.forEach(function (s) {
      const rows = b.stores[s];
      if (!Array.isArray(rows)) fail(CORRUPT);
      total += rows.length;
      if (total > MAX_RECORDS) fail('В копии слишком много записей.');
      const seen = new Set();
      rows.forEach(function (r) {
        if (!isObj(r) || typeof r.id !== 'string' || !ID_RE.test(r.id) || seen.has(r.id)) fail(CORRUPT);
        seen.add(r.id);
        checkB64(r.iv, 12, 12);
        checkB64(r.data, 16, MAX_RECORD_BYTES);
      });
    });
    return total;
  }

  /** Разбор и проверка текста файла: JSON, структура, контрольная сумма. */
  async function parseBackup(text) {
    if (typeof text !== 'string' || !text.trim()) fail('Файл пуст.');
    let obj;
    try { obj = JSON.parse(text); } catch (_) { fail('Файл не является корректным JSON.'); }
    validateStructure(obj);
    const sum = await sha256Hex(canonicalPayload(obj));
    if (sum !== obj.checksum) fail('Контрольная сумма не совпадает: файл повреждён или изменён.');
    return obj;
  }

  /* =====================================================
     Импорт
     ===================================================== */
  /** mode: 'replace' (заменить всё) или 'merge' (объединить). progress(text) — сообщения о ходе. */
  async function importBackup(b, password, mode, progress) {
    const C = VOID.crypto;
    const currentKey = VOID.auth.getKey();
    const say = typeof progress === 'function' ? progress : function () {};

    // 1. Пароль копии
    say('Проверка пароля копии…');
    const key = await C.deriveKey(password, decodeB64(b.kdf.salt), b.kdf.iterations);
    let passOk = false;
    try {
      const v = await C.decrypt(key, decodeB64(b.verifier.iv), decodeB64(b.verifier.data), VERIFY_AAD);
      passOk = !!v && v.check === VERIFY_TEXT;
    } catch (_) { passOk = false; }
    if (!passOk) fail('Неверный пароль резервной копии.');

    // 2. Манифест: состав копии должен совпадать с заверенным
    let manifest;
    try {
      manifest = await C.decrypt(key, decodeB64(b.manifest.iv), decodeB64(b.manifest.data), MANIFEST_AAD);
    } catch (_) { fail('Не удалось проверить состав копии: файл изменён или повреждён.'); }
    const digest = await sha256Hex(idsList(b.stores).join('\n'));
    if (!isObj(manifest) || manifest.idsDigest !== digest) {
      fail('Состав копии не совпадает с заверенным: файл изменён или повреждён.');
    }

    // 3. Расшифровка всех записей (при любой ошибке импорт отменяется до записи в базу)
    let total = 0;
    STORES.forEach(function (s) { total += b.stores[s].length; });
    const incoming = {};
    let n = 0;
    for (const s of STORES) {
      incoming[s] = [];
      for (const r of b.stores[s]) {
        let rec;
        try {
          rec = await C.decrypt(key, decodeB64(r.iv), decodeB64(r.data), s + ':' + r.id);
        } catch (_) { fail('Одна из записей повреждена. Импорт отменён, данные не изменены.'); }
        if (!isObj(rec) || rec.id !== r.id) fail('Одна из записей повреждена. Импорт отменён, данные не изменены.');
        incoming[s].push(rec);
        n++;
        if (n % 25 === 0) say('Расшифровка записей: ' + n + ' из ' + total);
      }
    }

    // 4. Отбор записей (для объединения сравниваем даты изменения)
    const local = {};
    if (mode === 'merge') {
      for (const s of STORES) {
        const rows = await VOID.db.getAllItems(s);
        local[s] = new Map(rows.map(function (x) { return [x.id, x]; }));
      }
    }
    const toWrite = [];
    let added = 0, updated = 0, skipped = 0;
    STORES.forEach(function (s) {
      incoming[s].forEach(function (rec) {
        if (mode === 'merge') {
          const ex = local[s].get(rec.id);
          if (ex) {
            const exTime = Number.isFinite(ex.updatedAt) ? ex.updatedAt : 0;
            const inTime = Number.isFinite(rec.updatedAt) ? rec.updatedAt : 0;
            if (exTime >= inTime) { skipped++; return; }
            updated++;
          } else { added++; }
        } else { added++; }
        toWrite.push({ store: s, rec: rec });
      });
    });

    // 5. Шифрование ключом текущего пароля
    say('Шифрование для этого устройства…');
    const puts = [];
    for (const w of toWrite) {
      const enc = await C.encrypt(currentKey, w.rec, w.store + ':' + w.rec.id);
      puts.push({ store: w.store, record: { id: w.rec.id, iv: enc.iv, data: enc.data } });
    }

    // 6. Одна транзакция: либо записано всё, либо ничего
    say('Сохранение…');
    const db = await VOID.db.open();
    await new Promise(function (resolve, reject) {
      const t = db.transaction(STORES, 'readwrite');
      t.oncomplete = function () { resolve(); };
      t.onerror = function () { reject(t.error || new Error('IDB_TX_ERROR')); };
      t.onabort = function () { reject(t.error || new Error('IDB_TX_ABORTED')); };
      try {
        if (mode === 'replace') STORES.forEach(function (s) { t.objectStore(s).clear(); });
        puts.forEach(function (p) { t.objectStore(p.store).put(p.record); });
      } catch (err) {
        try { t.abort(); } catch (_) { /* уже завершена */ }
        reject(err);
      }
    });

    // 7. Обновляем интерфейс
    if (VOID.auth.isUnlocked()) {
      await Promise.all(STORES.map(function (s) {
        return VOID[s] && VOID[s].reload ? VOID[s].reload() : null;
      }));
      if (typeof VOID.refreshDashboard === 'function') VOID.refreshDashboard();
    }
    return { added: added, updated: updated, skipped: skipped, total: total };
  }

  /* =====================================================
     Интерфейс (панель в разделе «Настройки»)
     ===================================================== */
  function messageFor(err) {
    if (err && err.user) return err.message;
    const m = err && err.message;
    if (m === 'LOCKED') return 'Хранилище заблокировано.';
    if (m === 'SHARE_UNSUPPORTED') return 'Этот браузер не умеет отправлять файлы. Используйте «Экспортировать».';
    if (m === 'BAD_SALT' || m === 'BAD_ITERATIONS') return CORRUPT;
    console.error('Backup error:', err);
    return 'Не удалось выполнить операцию. Подробности в консоли.';
  }

  function kv(label, value) {
    return el('div', { class: 'set-kv' }, [el('span', { text: label }), el('span', { text: value })]);
  }

  function buildPanel() {
    let pending = null; // проверенная копия, ожидающая импорта (только зашифрованные данные)
    let busy = false;

    const lastInfo = el('p', { class: 'set-hint' });
    const exportBtn = el('button', { class: 'btn btn--primary btn--block', type: 'button', text: 'Экспортировать резервную копию' });
    const shareBtn = el('button', { class: 'btn btn--block', type: 'button', text: 'Отправить через…' });
    const exportStatus = el('div', { class: 'set-status', 'aria-live': 'polite' });
    const exportError = el('p', { class: 'set-error', role: 'alert' });
    const note = el('p', { class: 'set-hint',
      text: 'Файл содержит только зашифрованные данные и защищён вашим мастер-паролем; сам пароль в него не попадает. ' +
            'Храните копию отдельно от телефона и не теряйте пароль: без него копию не открыть. ' +
            'Если скачанный файл не появился в «Загрузках», используйте «Отправить через…».' });

    const pickBtn = el('button', { class: 'btn btn--block', type: 'button', text: 'Импортировать из файла…' });
    const fileInput = el('input', { type: 'file', hidden: '', tabindex: '-1', 'aria-hidden': 'true' });
    const importResult = el('div', { class: 'set-status', 'aria-live': 'polite' });
    const importFileError = el('p', { class: 'set-error', role: 'alert' });

    const summary = el('div', { class: 'set-row' });
    const modeSelect = el('select', { class: 'select', 'aria-label': 'Режим импорта' }, [
      el('option', { value: 'replace', text: 'Заменить все данные' }),
      el('option', { value: 'merge', text: 'Объединить с текущими' })
    ]);
    const modeHint = el('p', { class: 'set-hint' });
    const pwInput = el('input', { type: 'password', autocomplete: 'off', autocapitalize: 'off',
      autocorrect: 'off', spellcheck: 'false' });
    const showPw = el('input', { type: 'checkbox' });
    const importBtn = el('button', { class: 'btn btn--primary btn--block', type: 'submit', text: 'Импортировать' });
    const cancelBtn = el('button', { class: 'btn btn--ghost btn--block', type: 'button', text: 'Отмена' });
    const importStatus = el('div', { class: 'set-status', 'aria-live': 'polite' });
    const importError = el('p', { class: 'set-error', role: 'alert' });
    const importForm = el('form', { class: 'set-form', autocomplete: 'off', novalidate: '', hidden: '' }, [
      summary,
      modeSelect,
      modeHint,
      el('label', { class: 'field' }, [el('span', { text: 'Пароль этой копии' }), pwInput]),
      el('label', { class: 'check' }, [showPw, el('span', { text: 'Показать пароль' })]),
      importBtn, cancelBtn, importStatus, importError
    ]);

    const HINTS = {
      replace: 'Все текущие данные будут удалены и заменены содержимым копии. Пароль приложения останется прежним: пароль копии нужен только для чтения.',
      merge: 'Новые записи добавятся. Если запись есть и там и тут, останется более свежая.'
    };

    function setBusy(on) {
      busy = on;
      [exportBtn, shareBtn, pickBtn, importBtn, cancelBtn].forEach(function (b) { b.disabled = on; });
    }

    async function refresh() {
      try {
        const s = (await VOID.db.getMeta('settings')) || {};
        lastInfo.textContent = Number.isFinite(s.lastBackupAt)
          ? 'Последняя копия: ' + ui.formatDateTime(s.lastBackupAt)
          : 'Резервных копий пока не создавалось. Рекомендуем сделать первую.';
      } catch (_) { /* не критично */ }
    }

    function hideImport() {
      pending = null;
      importForm.hidden = true;
      pwInput.value = '';
      pwInput.type = 'password';
      showPw.checked = false;
      importStatus.textContent = '';
      importError.textContent = '';
      summary.textContent = '';
    }

    function reset() {
      hideImport();
      exportStatus.textContent = '';
      exportError.textContent = '';
      importResult.textContent = '';
      importFileError.textContent = '';
      busy = false;
      setBusy(false);
    }

    async function doExport(mode) {
      if (busy) return;
      exportError.textContent = '';
      exportStatus.textContent = 'Подготовка…';
      setBusy(true);
      try {
        const n = await exportBackup(mode);
        exportStatus.textContent = 'Готово: ' + n + ' ' + plural(n, RECORD_FORMS) + ' в копии.';
        VOID.toast('Резервная копия создана');
        refresh();
      } catch (err) {
        exportStatus.textContent = '';
        if (err && err.name === 'AbortError') exportStatus.textContent = 'Отправка отменена.';
        else exportError.textContent = messageFor(err);
      } finally {
        setBusy(false);
      }
    }

    async function onFileChosen() {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!file || busy) return;
      importResult.textContent = '';
      importFileError.textContent = '';
      hideImport();
      if (file.size > MAX_FILE_BYTES) { importFileError.textContent = 'Файл слишком большой.'; return; }
      setBusy(true);
      importResult.textContent = 'Проверка файла…';
      try {
        const text = await file.text();
        const b = await parseBackup(text);
        pending = b;
        showImport(b);
        importResult.textContent = '';
      } catch (err) {
        pending = null;
        importResult.textContent = '';
        importFileError.textContent = messageFor(err);
      } finally {
        setBusy(false);
      }
    }

    function showImport(b) {
      summary.textContent = '';
      const created = Date.parse(b.createdAt);
      summary.appendChild(kv('Создана', Number.isFinite(created) ? ui.formatDateTime(created) : 'неизвестно'));
      STORES.forEach(function (s) { summary.appendChild(kv(STORE_LABELS[s], String(b.stores[s].length))); });
      modeSelect.value = 'replace';
      modeHint.textContent = HINTS.replace;
      importForm.hidden = false;
      setTimeout(function () { pwInput.focus(); }, 60);
    }

    async function onImport(e) {
      e.preventDefault();
      if (busy || !pending) return;
      importError.textContent = '';
      const pw = pwInput.value;
      if (!pw) { importError.textContent = 'Введите пароль резервной копии.'; return; }
      const mode = modeSelect.value === 'merge' ? 'merge' : 'replace';

      if (mode === 'replace') {
        const ok = await ui.confirm({
          title: 'Заменить все данные?',
          text: 'Все текущие записи Дневника, Архива, Soundscape и Хронологии на этом устройстве будут удалены и заменены содержимым копии. Если не уверены, сначала экспортируйте текущие данные.',
          confirmText: 'Заменить'
        });
        if (!ok) return;
      }
      if (!pending) return;

      setBusy(true);
      try {
        const res = await importBackup(pending, pw, mode, function (t) { importStatus.textContent = t; });
        hideImport();
        importResult.textContent = mode === 'replace'
          ? 'Импорт завершён: загружено ' + res.total + ' ' + plural(res.total, RECORD_FORMS) + '.'
          : 'Импорт завершён: добавлено ' + res.added + ', обновлено ' + res.updated + ', пропущено ' + res.skipped + '.';
        VOID.toast('Импорт завершён');
      } catch (err) {
        importStatus.textContent = '';
        importError.textContent = messageFor(err);
      } finally {
        setBusy(false);
      }
    }

    exportBtn.addEventListener('click', function () { doExport('download'); });
    shareBtn.addEventListener('click', function () { doExport('share'); });
    pickBtn.addEventListener('click', function () { if (!busy) fileInput.click(); });
    fileInput.addEventListener('change', onFileChosen);
    importForm.addEventListener('submit', onImport);
    cancelBtn.addEventListener('click', hideImport);
    modeSelect.addEventListener('change', function () { modeHint.textContent = HINTS[modeSelect.value] || ''; });
    showPw.addEventListener('change', function () { pwInput.type = showPw.checked ? 'text' : 'password'; });

    // Блокировка: стираем всё, что связано с импортом, с экрана и из памяти
    document.addEventListener('void:lock', reset);

    const node = el('div', { class: 'set-panel' }, [
      lastInfo,
      el('div', { class: 'btn-row' }, [exportBtn, shareBtn]),
      exportStatus, exportError, note,
      pickBtn, fileInput, importResult, importFileError, importForm
    ]);
    return { node: node, refresh: refresh, reset: reset };
  }

  VOID.backup = {
    FORMAT_VERSION: FORMAT_VERSION,
    createBackup: createBackup,
    exportBackup: exportBackup,
    parseBackup: parseBackup,
    importBackup: importBackup,
    buildPanel: buildPanel
  };
})();