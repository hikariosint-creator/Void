/* ===== VOID — локальная база данных (этап 2) =====
   IndexedDB с двумя уровнями:
   1) «Сырой» (raw): хранение записей как есть.
   2) «Защищённый» (saveItem/getItem/...): всё содержимое шифруется ключом из auth.js.

   В IndexedDB лежит только {id, iv, data}. Заголовки, тексты, теги, даты —
   всё находится ВНУТРИ зашифрованного блока. Ключ в базе не хранится.
   Исключение — таблица meta: соль, параметры, проверочный блок и настройки
   (они не содержат личных данных). */

(function () {
  'use strict';

  const VOID = window.VOID = window.VOID || {};

  const DB_NAME = 'void-db';
  const DB_VERSION = 1;
  const META_STORE = 'meta';
  // journal — дневник, archive — архив, soundscape — музыка, timeline — события, drafts — черновики
  const DATA_STORES = ['journal', 'archive', 'soundscape', 'timeline', 'drafts'];

  let dbPromise = null;

  function assertStore(name) {
    if (!DATA_STORES.includes(name)) throw new Error('UNKNOWN_STORE: ' + name);
  }

  /** Открытие базы (один раз, результат переиспользуется). */
  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('IDB_UNSUPPORTED')); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: 'key' });
        DATA_STORES.forEach(name => {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
        });
      };
      req.onsuccess = () => {
        const db = req.result;
        // Если другая вкладка обновляет/удаляет базу — закрываемся и откроемся заново при необходимости
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => reject(req.error || new Error('IDB_OPEN_FAILED'));
      req.onblocked = () => reject(new Error('IDB_BLOCKED'));
    });
    dbPromise.catch(() => { dbPromise = null; }); // после ошибки можно попробовать снова
    return dbPromise;
  }

  /** Универсальная транзакция: work(store) возвращает IDBRequest, результат вернётся после завершения. */
  function tx(storeName, mode, work) {
    return open().then(db => new Promise((resolve, reject) => {
      let result;
      const t = db.transaction(storeName, mode);
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error || new Error('IDB_TX_ERROR'));
      t.onabort = () => reject(t.error || new Error('IDB_TX_ABORTED'));
      try {
        const req = work(t.objectStore(storeName));
        if (req) req.onsuccess = () => { result = req.result; };
      } catch (err) {
        try { t.abort(); } catch (_) { /* уже завершена */ }
        reject(err);
      }
    }));
  }

  /* ---------- Служебные данные (meta) ---------- */
  async function getMeta(key) {
    const rec = await tx(META_STORE, 'readonly', s => s.get(key));
    return rec ? rec.value : undefined;
  }
  function setMeta(key, value) {
    return tx(META_STORE, 'readwrite', s => s.put({ key: key, value: value }));
  }

  /* ---------- «Сырой» уровень ---------- */
  function putRaw(store, record) { assertStore(store); return tx(store, 'readwrite', s => s.put(record)); }
  function getRaw(store, id) { assertStore(store); return tx(store, 'readonly', s => s.get(id)); }
  function getAllRaw(store) { assertStore(store); return tx(store, 'readonly', s => s.getAll()); }
  function deleteRaw(store, id) { assertStore(store); return tx(store, 'readwrite', s => s.delete(id)); }
  function clearStore(store) { assertStore(store); return tx(store, 'readwrite', s => s.clear()); }
  function countRaw(store) { assertStore(store); return tx(store, 'readonly', s => s.count()); }

  /* ---------- Защищённый уровень ---------- */
  function aadFor(store, id) { return store + ':' + id; }

  /** Сохраняет объект в зашифрованном виде. Если id нет — создаётся.
      createdAt/updatedAt проставляются автоматически. */
  async function saveItem(store, item) {
    assertStore(store);
    const key = VOID.auth.getKey(); // бросит ошибку, если хранилище заблокировано
    const now = Date.now();
    const rec = Object.assign({}, item);
    if (!rec.id) rec.id = VOID.crypto.randomId();
    if (!rec.createdAt) rec.createdAt = now;
    rec.updatedAt = now;
    const enc = await VOID.crypto.encrypt(key, rec, aadFor(store, rec.id));
    await putRaw(store, { id: rec.id, iv: enc.iv, data: enc.data });
    return rec;
  }

  /** Читает и расшифровывает одну запись (null, если её нет). */
  async function getItem(store, id) {
    assertStore(store);
    const key = VOID.auth.getKey();
    const raw = await getRaw(store, id);
    if (!raw) return null;
    return VOID.crypto.decrypt(key, raw.iv, raw.data, aadFor(store, raw.id));
  }

  /** Читает и расшифровывает все записи раздела. Повреждённые пропускаются (с записью в консоль). */
  async function getAllItems(store) {
    assertStore(store);
    const key = VOID.auth.getKey();
    const rows = await getAllRaw(store);
    const out = [];
    for (const raw of rows) {
      try {
        out.push(await VOID.crypto.decrypt(key, raw.iv, raw.data, aadFor(store, raw.id)));
      } catch (err) {
        console.error('Не удалось расшифровать запись', store, raw.id);
      }
    }
    return out;
  }

  function deleteItem(store, id) { return deleteRaw(store, id); }

  /** Полное удаление базы (для «Сброса приложения» на этапе 6). */
  async function destroy() {
    try { const db = await open(); db.close(); } catch (_) { /* базы может не быть */ }
    dbPromise = null;
    return new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => resolve();
    });
  }

  /* ---------- Данные для Dashboard ---------- */
  VOID.providers = VOID.providers || {};

  // Счётчики не требуют расшифровки — считаем количество записей в хранилищах
  VOID.providers.counts = async function () {
    return {
      entries: await countRaw('journal'),
      archive: await countRaw('archive'),
      events: await countRaw('timeline')
    };
  };

  // Последние записи дневника (требует разблокированного хранилища)
  VOID.providers.recent = async function (limit) {
    const items = await getAllItems('journal');
    items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return items.slice(0, limit).map(it => ({
      title: it.title,
      meta: new Date(it.updatedAt || it.createdAt || Date.now()).toLocaleString('ru-RU',
        { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    }));
  };

  /* ---------- Самопроверка шифрования ---------- */
  function containsBytes(haystack, needle) {
    outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (haystack[i + j] !== needle[j]) continue outer;
      }
      return true;
    }
    return false;
  }

  /** Реальная проверка: пишет тестовую запись в раздел drafts, проверяет её и удаляет. */
  async function selfTest() {
    const results = [];
    const add = (name, ok, detail) => results.push({ name: name, ok: !!ok, detail: detail || '' });
    const key = VOID.auth.getKey();
    const marker = 'VOID-SELFTEST-' + VOID.crypto.randomId();
    const idA = 'selftest-a';
    const idB = 'selftest-b';

    try {
      add('Ключ нельзя извлечь из памяти', key.extractable === false, 'extractable = ' + key.extractable);

      await open();
      add('База IndexedDB доступна', true);

      await saveItem('drafts', { id: idA, secret: marker });
      const back = await getItem('drafts', idA);
      add('Запись шифруется и расшифровывается', back && back.secret === marker);

      const raw1 = await getRaw('drafts', idA);
      const fields = Object.keys(raw1).sort().join(', ');
      const leaked = containsBytes(new Uint8Array(raw1.data), new TextEncoder().encode(marker));
      add('В базе нет открытого текста', !leaked && fields === 'data, id, iv', 'поля записи: ' + fields);

      await saveItem('drafts', { id: idA, secret: marker });
      const raw2 = await getRaw('drafts', idA);
      add('IV уникален для каждой операции',
        VOID.crypto.toB64(raw1.iv) !== VOID.crypto.toB64(raw2.iv));

      // Перенос зашифрованного блока под другой идентификатор должен ломаться
      await putRaw('drafts', { id: idB, iv: raw2.iv, data: raw2.data });
      let swapDetected = false;
      try { await getItem('drafts', idB); } catch (_) { swapDetected = true; }
      add('Подмена записи обнаруживается', swapDetected);

      // Изменение одного бита шифртекста должно ломать расшифровку
      const tampered = new Uint8Array(raw2.data).slice();
      tampered[0] ^= 1;
      await putRaw('drafts', { id: idA, iv: raw2.iv, data: tampered.buffer });
      let tamperDetected = false;
      try { await getItem('drafts', idA); } catch (_) { tamperDetected = true; }
      add('Изменение шифртекста обнаруживается', tamperDetected);
    } catch (err) {
      console.error(err);
      add('Тест завершился ошибкой', false, String(err && err.message));
    } finally {
      try { await deleteRaw('drafts', idA); await deleteRaw('drafts', idB); } catch (_) { /* уже удалены */ }
    }
    return results;
  }

  VOID.db = {
    STORES: DATA_STORES.slice(),
    open, getMeta, setMeta,
    putRaw, getRaw, getAllRaw, deleteRaw, clearStore, countRaw,
    saveItem, getItem, getAllItems, deleteItem,
    destroy, selfTest
  };
})();