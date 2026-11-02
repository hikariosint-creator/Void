/* ===== VOID — универсальный движок коллекций (этап 4) =====
   Используется Дневником, Архивом, Soundscape и Timeline. Строит:
   - список с поиском, фильтрами (теги, категории, избранное), сортировкой;
   - редактор на весь экран;
   - автосохранение черновиков (в зашифрованном виде, раздел drafts);
   - создание, редактирование, удаление с подтверждением.

   Поля записи описываются конфигом:
     cfg.fields — массив {key, type:'text'|'area'|'date'|'select', label, placeholder, maxLength, options}
     cfg.titleKey — поле, служащее заголовком (по умолчанию 'title')
     cfg.bodyKey — большое текстовое поле ('body'); null — если его нет
     cfg.tags / cfg.favorite — включают теги и избранное
     cfg.dateKey — поле-дата, по которому сортируется и которое показывается в карточке
     cfg.card(item) — свой вид карточки, cfg.renderList(shown, ctx) — свой вид списка
     cfg.filter(item) — дополнительное условие показа (для вкладок)
     cfg.defaults() — значения для новой записи
     cfg.beforeOpen(draft) — подготовка редактора перед показом
   Расшифрованные записи лежат в памяти только пока хранилище разблокировано. */

(function () {
  'use strict';

  const VOID = window.VOID = window.VOID || {};
  const ui = VOID.ui;
  const el = ui.el;

  const MAX_TITLE = 200;
  const MAX_BODY = 100000;
  const MAX_TAGS_TEXT = 400;
  const DRAFT_DELAY = 800; // мс после последнего нажатия клавиши
  const SORTS = [
    ['updated-desc', 'Недавно изменённые'],
    ['created-desc', 'Сначала новые'],
    ['created-asc', 'Сначала старые']
  ];
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  function createCollection(cfg) {
    const L = cfg.labels;
    const titleKey = cfg.titleKey || 'title';
    const bodyKey = cfg.bodyKey === undefined ? 'body' : cfg.bodyKey;
    const categories = Array.isArray(cfg.categories) ? cfg.categories : null;
    const defaultCategory = categories ? (cfg.defaultCategory || categories[0]) : '';
    const useTags = cfg.tags !== false;
    const useFav = !!cfg.favorite;
    const extraFields = cfg.fields || [];
    const view = document.getElementById(cfg.viewId);
    const appRoot = document.getElementById('app');
    const NEW_DRAFT_ID = cfg.draftKind + '-new';

    let items = [];              // расшифрованные записи (очищается при блокировке)
    let loaded = false;
    let loadingPromise = null;
    let editing = null;          // состояние открытого редактора: { id, baseline, finished }
    let saving = false;
    let draftTimer = null;
    let draftWrite = Promise.resolve(); // очередь записи черновиков, чтобы операции не перемешались
    const filters = { query: '', tag: '', category: '', favOnly: false, sort: cfg.defaultSort || 'updated-desc' };

    const draftIdFor = function (id) { return id ? cfg.draftKind + '-edit-' + id : NEW_DRAFT_ID; };
    const str = function (v) { return typeof v === 'string' ? v : ''; };
    const validCategory = function (c) {
      return categories ? (categories.includes(c) ? c : defaultCategory) : '';
    };
    const notifyChange = function () {
      if (typeof VOID.refreshDashboard === 'function') VOID.refreshDashboard();
    };

    /* ---------- Приведение данных к безопасному виду ---------- */
    function cleanField(f, v) {
      let s = str(v);
      if (f.type === 'date' && !DATE_RE.test(s)) s = '';
      if (f.type === 'select' && f.options && !f.options.some(function (o) { return o[0] === s; })) {
        s = f.options.length ? f.options[0][0] : '';
      }
      return s;
    }

    function normalize(raw) {
      if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null;
      const it = {
        id: raw.id,
        tags: useTags && Array.isArray(raw.tags) ? raw.tags.filter(function (t) { return typeof t === 'string'; }) : [],
        category: validCategory(raw.category),
        favorite: useFav && raw.favorite === true,
        createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
        updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0
      };
      it[titleKey] = str(raw[titleKey]);
      if (bodyKey) it[bodyKey] = str(raw[bodyKey]);
      extraFields.forEach(function (f) { it[f.key] = cleanField(f, raw[f.key]); });
      return it;
    }

    /* =====================================================
       Построение интерфейса списка
       ===================================================== */
    const newBtn = el('button', { class: 'btn btn--primary btn--block', type: 'button' },
      [ui.icon('plus'), el('span', { text: L.newButton })]);
    const searchInput = el('input', { class: 'input', type: 'search', placeholder: L.searchPlaceholder,
      maxlength: 100, autocomplete: 'off', 'aria-label': 'Поиск' });
    const tagSelect = useTags ? el('select', { class: 'select', 'aria-label': 'Фильтр по тегу' }) : null;
    const catFilter = categories ? el('select', { class: 'select', 'aria-label': 'Фильтр по категории' }) : null;
    const favSelect = useFav ? el('select', { class: 'select', 'aria-label': 'Избранное' }) : null;
    const sortSelect = el('select', { class: 'select', 'aria-label': 'Сортировка' });
    const toolbar = el('div', { class: 'toolbar' }, [
      newBtn, searchInput, el('div', { class: 'toolbar__row' }, [tagSelect, catFilter, favSelect, sortSelect])
    ]);
    const draftsBox = el('div', { class: 'list list--drafts', 'aria-live': 'polite' });
    const listBox = el('div', { class: 'list', 'aria-live': 'polite' });

    if (catFilter) {
      catFilter.appendChild(el('option', { value: '', text: 'Все категории' }));
      categories.forEach(function (c) { catFilter.appendChild(el('option', { value: c, text: c })); });
    }
    if (favSelect) {
      favSelect.appendChild(el('option', { value: '', text: 'Все' }));
      favSelect.appendChild(el('option', { value: '1', text: 'Только избранное' }));
    }
    const sortOptions = cfg.sorts || SORTS;
    sortOptions.forEach(function (s) { sortSelect.appendChild(el('option', { value: s[0], text: s[1] })); });
    sortSelect.value = filters.sort;

    view.textContent = '';
    if (cfg.topNode) view.appendChild(cfg.topNode); // например, вкладки Soundscape
    view.append(toolbar, draftsBox, listBox);

    /* =====================================================
       Построение редактора (оверлей на весь экран)
       ===================================================== */
    const backBtn = el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Назад' }, [ui.icon('back')]);
    const barTitle = el('div', { class: 'editor__title', text: L.editorNew });
    const saveBtn = el('button', { class: 'btn btn--primary btn--small', type: 'button', text: 'Сохранить' });
    const nameInput = el('input', { class: 'editor__name', type: 'text', placeholder: L.titlePlaceholder,
      maxlength: MAX_TITLE, autocomplete: 'off', 'aria-label': L.titlePlaceholder });
    const catSelect = categories ? el('select', { class: 'select editor__select', 'aria-label': 'Категория' }) : null;
    const favToggle = useFav
      ? el('button', { class: 'fav-toggle', type: 'button', 'aria-pressed': 'false' },
          [ui.icon('star'), el('span', { text: 'Добавить в избранное' })])
      : null;
    const bodyInput = bodyKey
      ? el('textarea', { class: 'editor__text', placeholder: L.bodyPlaceholder,
          maxlength: MAX_BODY, 'aria-label': L.bodyLabel })
      : null;
    const tagsInput = useTags
      ? el('input', { class: 'editor__tags', type: 'text', placeholder: 'Теги через запятую',
          maxlength: MAX_TAGS_TEXT, autocomplete: 'off', 'aria-label': 'Теги' })
      : null;
    const meta = el('div', { class: 'editor__meta' });
    const status = el('div', { class: 'editor__status', 'aria-live': 'polite' });
    const deleteBtn = el('button', { class: 'btn btn--danger btn--block', type: 'button', text: L.deleteButton });
    const discardBtn = el('button', { class: 'btn btn--ghost btn--block', type: 'button', text: 'Отбросить изменения' });

    if (catSelect) categories.forEach(function (c) { catSelect.appendChild(el('option', { value: c, text: c })); });

    // Дополнительные поля из конфига: создаём элементы и запоминаем их по ключу
    const fieldEls = {};
    const fieldNodes = extraFields.map(function (f) {
      let node;
      if (f.type === 'area') {
        node = el('textarea', { class: 'editor__text', placeholder: f.placeholder || '',
          maxlength: f.maxLength || MAX_BODY, 'aria-label': f.label });
      } else if (f.type === 'select') {
        node = el('select', { class: 'select editor__select', 'aria-label': f.label });
        (f.options || []).forEach(function (o) { node.appendChild(el('option', { value: o[0], text: o[1] })); });
      } else if (f.type === 'date') {
        node = el('input', { class: 'editor__line', type: 'date', 'aria-label': f.label });
      } else {
        node = el('input', { class: 'editor__line', type: 'text', placeholder: f.placeholder || '',
          maxlength: f.maxLength || 200, autocomplete: 'off', 'aria-label': f.label });
      }
      fieldEls[f.key] = node;
      return node;
    });

    const editorEl = el('div', { class: 'editor', role: 'dialog', 'aria-modal': 'true',
      'aria-label': L.editorLabel, hidden: '' }, [
      el('div', { class: 'editor__bar' }, [backBtn, barTitle, saveBtn]),
      el('div', { class: 'editor__body' },
        [nameInput].concat(fieldNodes, [catSelect, favToggle, bodyInput, tagsInput, meta, status, discardBtn, deleteBtn]))
    ]);
    appRoot.appendChild(editorEl);

    /* =====================================================
       Список: фильтрация, сортировка, отрисовка
       ===================================================== */
    function sortKeyDate(it) {
      return cfg.dateKey && it[cfg.dateKey] ? it[cfg.dateKey] : '';
    }

    function visibleItems() {
      const tokens = filters.query.toLowerCase().split(/\s+/).filter(Boolean);
      const list = items.filter(function (it) {
        if (cfg.filter && !cfg.filter(it)) return false;
        if (useTags && filters.tag && !it.tags.includes(filters.tag)) return false;
        if (filters.category && it.category !== filters.category) return false;
        if (filters.favOnly && !it.favorite) return false;
        if (!tokens.length) return true;
        const parts = [it[titleKey], bodyKey ? it[bodyKey] : '', it.tags.join(' '), it.category];
        extraFields.forEach(function (f) { if (f.type !== 'date') parts.push(it[f.key]); });
        const hay = parts.join('\n').toLowerCase();
        return tokens.every(function (t) { return hay.includes(t); });
      });
      const s = filters.sort;
      list.sort(function (a, b) {
        if (s === 'date-desc' || s === 'date-asc') {
          const da = sortKeyDate(a), db = sortKeyDate(b);
          if (da !== db) return s === 'date-desc' ? (da < db ? 1 : -1) : (da < db ? -1 : 1);
          return b.createdAt - a.createdAt;
        }
        if (s === 'title-asc') return a[titleKey].localeCompare(b[titleKey], 'ru');
        if (s === 'created-asc') return a.createdAt - b.createdAt;
        if (s === 'created-desc') return b.createdAt - a.createdAt;
        return b.updatedAt - a.updatedAt;
      });
      return list;
    }

    function refreshTagOptions() {
      if (!tagSelect) return;
      const counts = new Map();
      items.forEach(function (it) {
        if (cfg.filter && !cfg.filter(it)) return;
        it.tags.forEach(function (t) { counts.set(t, (counts.get(t) || 0) + 1); });
      });
      if (filters.tag && !counts.has(filters.tag)) filters.tag = '';
      tagSelect.textContent = '';
      tagSelect.appendChild(el('option', { value: '', text: 'Все теги' }));
      Array.from(counts.keys()).sort(function (a, b) { return a.localeCompare(b, 'ru'); }).forEach(function (t) {
        tagSelect.appendChild(el('option', { value: t, text: '#' + t + ' (' + counts.get(t) + ')' }));
      });
      tagSelect.value = filters.tag;
    }

    function dateMeta(it) {
      let t = 'Создано ' + ui.formatDate(it.createdAt);
      if (it.updatedAt - it.createdAt > 60000) t += ' · изменено ' + ui.formatDateTime(it.updatedAt);
      return t;
    }

    function buildFavButton(it) {
      const b = el('button', { class: 'fav-btn' + (it.favorite ? ' on' : ''), type: 'button',
        'data-fav': it.id, 'aria-pressed': it.favorite ? 'true' : 'false',
        'aria-label': it.favorite ? 'Убрать из избранного' : 'В избранное' }, [ui.icon('star')]);
      return b;
    }

    function buildCard(it) {
      const card = el('button', { class: 'list-item list-item--click', type: 'button', 'data-id': it.id });
      if (it.category) card.appendChild(el('div', { class: 'card-cat', text: it.category }));
      card.appendChild(el('div', { class: 'list-item__title', text: it[titleKey] || 'Без названия' }));
      const sn = bodyKey ? ui.snippet(it[bodyKey], 140) : '';
      if (sn) card.appendChild(el('div', { class: 'card-snippet', text: sn }));
      if (it.tags.length) card.appendChild(ui.tagChips(it.tags));
      card.appendChild(el('div', { class: 'list-item__meta', text: dateMeta(it) }));
      return card;
    }

    /** Сборка карточки: свою версию описывает cfg.card, избранное добавляется поверх. */
    function buildItemNode(it) {
      const card = cfg.card ? cfg.card(it, { el: el, ui: ui }) : buildCard(it);
      if (!useFav) return card;
      return el('div', { class: 'card-wrap' }, [card, buildFavButton(it)]);
    }

    function renderList() {
      listBox.textContent = '';
      if (!loaded) { listBox.appendChild(ui.emptyBlock('Загрузка…', '')); return; }
      const scoped = cfg.filter ? items.filter(cfg.filter) : items;
      if (!scoped.length) {
        const e = cfg.emptyFor ? cfg.emptyFor() : { title: L.emptyTitle, text: L.emptyText };
        listBox.appendChild(ui.emptyBlock(e.title, e.text));
        return;
      }
      const shown = visibleItems();
      if (!shown.length) {
        listBox.appendChild(ui.emptyBlock('Ничего не найдено', 'Измените запрос или фильтры.'));
        return;
      }
      if (cfg.renderList) cfg.renderList(shown, listBox, buildItemNode, { el: el, ui: ui, sort: filters.sort });
      else shown.forEach(function (it) { listBox.appendChild(buildItemNode(it)); });
    }

    /** Блок «Черновики»: несохранённые тексты, которые можно продолжить. */
    async function refreshDrafts() {
      let drafts = [];
      try {
        const all = await VOID.db.getAllItems('drafts');
        drafts = all.filter(function (d) { return d && d.kind === cfg.draftKind; });
      } catch (err) {
        if (!(err && err.message === 'LOCKED')) console.error('Drafts error:', err);
      }
      draftsBox.textContent = '';
      drafts.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
      drafts.forEach(function (d) {
        // Черновик правки записи, которой уже нет, удаляем
        if (d.entryId && !items.some(function (it) { return it.id === d.entryId; })) {
          VOID.db.deleteItem('drafts', d.id).catch(function () {});
          return;
        }
        const v = d.values && typeof d.values === 'object' ? d.values : {};
        const title = str(v[titleKey]) || (bodyKey ? ui.snippet(str(v[bodyKey]), 60) : '') || 'Без названия';
        const row = el('button', { class: 'list-item list-item--click list-item--draft', type: 'button',
          'data-draft-entry': str(d.entryId) });
        row.append(
          el('div', { class: 'card-cat', text: 'ЧЕРНОВИК' }),
          el('div', { class: 'list-item__title', text: title }),
          el('div', { class: 'list-item__meta', text: 'Не сохранено · ' + ui.formatDateTime(d.updatedAt) })
        );
        draftsBox.appendChild(row);
      });
    }

    /* ---------- Загрузка данных ---------- */
    function reload() {
      if (loadingPromise) return loadingPromise;
      loaded = false;
      renderList();
      loadingPromise = (async function () {
        try {
          const rows = await VOID.db.getAllItems(cfg.store);
          if (!VOID.auth.isUnlocked()) return; // заблокировались, пока шла загрузка
          items = rows.map(normalize).filter(Boolean);
          loaded = true;
        } catch (err) {
          if (!(err && err.message === 'LOCKED')) {
            console.error('Load error:', err);
            VOID.toast('Не удалось загрузить раздел «' + L.name + '»', 'error');
          }
          return;
        }
        refreshTagOptions();
        renderList();
        await refreshDrafts();
      })().finally(function () { loadingPromise = null; });
      return loadingPromise;
    }

    function ensureLoaded() { return loaded ? Promise.resolve() : reload(); }

    /* =====================================================
       Редактор: форма, черновики
       ===================================================== */
    /** Снимок формы: все поля в виде строк (теги — как введены), избранное — булево. */
    function readForm() {
      const v = {};
      v[titleKey] = nameInput.value;
      if (bodyKey) v[bodyKey] = bodyInput.value;
      extraFields.forEach(function (f) { v[f.key] = fieldEls[f.key].value; });
      v.tags = tagsInput ? tagsInput.value : '';
      v.category = catSelect ? catSelect.value : '';
      v.favorite = favToggle ? favToggle.classList.contains('on') : false;
      return v;
    }

    function writeForm(v) {
      nameInput.value = v[titleKey] || '';
      if (bodyKey) bodyInput.value = v[bodyKey] || '';
      extraFields.forEach(function (f) { fieldEls[f.key].value = v[f.key] || ''; });
      if (tagsInput) tagsInput.value = v.tags || '';
      if (catSelect) catSelect.value = v.category || defaultCategory;
      setFav(!!v.favorite);
    }

    function setFav(on) {
      if (!favToggle) return;
      favToggle.classList.toggle('on', on);
      favToggle.setAttribute('aria-pressed', on ? 'true' : 'false');
      favToggle.querySelector('span').textContent = on ? 'В избранном' : 'Добавить в избранное';
    }

    function isChanged(a, b) {
      return Object.keys(a).some(function (k) { return a[k] !== b[k]; });
    }

    /** Форма «пустая», если нет ни одного значимого текста. Для Timeline значим и заголовок. */
    function isBlank(s) {
      const keys = [titleKey].concat(bodyKey ? [bodyKey] : [], extraFields.map(function (f) { return f.key; }));
      const hasText = keys.some(function (k) {
        const f = extraFields.find(function (x) { return x.key === k; });
        if (f && (f.type === 'select' || f.type === 'date')) return false; // они всегда что-то содержат
        return str(s[k]).trim();
      });
      return !hasText && !str(s.tags).trim();
    }

    function snapshotOf(item) {
      if (item) {
        const v = { tags: ui.tagsToString(item.tags), category: item.category, favorite: item.favorite };
        v[titleKey] = item[titleKey];
        if (bodyKey) v[bodyKey] = item[bodyKey];
        extraFields.forEach(function (f) { v[f.key] = item[f.key]; });
        return v;
      }
      const d = Object.assign({ tags: '', category: defaultCategory, favorite: false }, cfg.defaults ? cfg.defaults() : {});
      d[titleKey] = d[titleKey] || '';
      if (bodyKey) d[bodyKey] = d[bodyKey] || '';
      extraFields.forEach(function (f) {
        if (d[f.key] === undefined) d[f.key] = f.type === 'select' && f.options.length ? f.options[0][0] : '';
      });
      return d;
    }

    function clearEditorFields() {
      writeForm(snapshotOf(null));
      meta.textContent = ''; status.textContent = '';
    }

    /** Записывает (или удаляет) черновик. Снимок формы берётся СРАЗУ, запись идёт в очереди.
        Результат: 'saved' | 'cleared' | 'failed'. */
    function persistDraft(state, snap) {
      const dirty = isChanged(snap, state.baseline) && !isBlank(snap);
      const id = draftIdFor(state.id);
      draftWrite = draftWrite.then(async function () {
        try {
          if (dirty) {
            await VOID.db.saveItem('drafts', { id: id, kind: cfg.draftKind, entryId: state.id, values: snap });
            return 'saved';
          }
          await VOID.db.deleteItem('drafts', id);
          return 'cleared';
        } catch (err) {
          if (!(err && err.message === 'LOCKED')) console.error('Draft error:', err);
          return 'failed';
        }
      });
      return draftWrite;
    }

    /** Немедленно сохраняет черновик (перед блокировкой или сворачиванием приложения). */
    function flushDraft() {
      clearTimeout(draftTimer);
      draftTimer = null;
      if (!editing || editing.finished) return Promise.resolve();
      return persistDraft(editing, readForm());
    }

    function onEditorInput() {
      if (!editing || editing.finished) return;
      clearTimeout(draftTimer);
      draftTimer = setTimeout(async function () {
        draftTimer = null;
        const state = editing;
        if (!state || state.finished) return;
        const result = await persistDraft(state, readForm());
        if (editing === state) {
          status.textContent = result === 'saved' ? 'Черновик сохранён · ' + ui.formatTime(Date.now()) : '';
        }
      }, DRAFT_DELAY);
    }

    /** Восстановление значений из черновика с проверкой типов. */
    function valuesFromDraft(d) {
      const raw = d && d.values && typeof d.values === 'object' ? d.values : {};
      const base = snapshotOf(null);
      const v = {};
      v[titleKey] = str(raw[titleKey]);
      if (bodyKey) v[bodyKey] = str(raw[bodyKey]);
      extraFields.forEach(function (f) {
        v[f.key] = raw[f.key] === undefined ? base[f.key] : cleanField(f, raw[f.key]);
      });
      v.tags = str(raw.tags);
      v.category = validCategory(raw.category);
      v.favorite = raw.favorite === true;
      return v;
    }

    /* ---------- Открытие и закрытие редактора ---------- */
    async function openEditor(entryId, preset) {
      if (editing || !VOID.auth.isUnlocked()) return;
      if (!loaded) await ensureLoaded();
      if (editing || !VOID.auth.isUnlocked()) return;

      const existing = entryId ? items.find(function (it) { return it.id === entryId; }) : null;
      if (entryId && !existing) { VOID.toast('Запись не найдена', 'error'); return; }

      const baseline = snapshotOf(existing);
      if (!existing && preset && typeof preset === 'object') Object.assign(baseline, preset);
      const state = { id: existing ? existing.id : null, baseline: baseline, finished: false };
      editing = state; // занимаем редактор сразу, чтобы двойное нажатие не открыло два

      let values = baseline;
      let restored = false;
      try {
        const d = await VOID.db.getItem('drafts', draftIdFor(state.id));
        if (d && d.kind === cfg.draftKind) { values = valuesFromDraft(d); restored = true; }
      } catch (err) {
        if (!(err && err.message === 'LOCKED')) console.error('Draft read error:', err);
      }
      if (editing !== state || !VOID.auth.isUnlocked()) return; // за время ожидания заблокировали

      if (cfg.beforeOpen) cfg.beforeOpen({ items: items, existing: existing, fields: fieldEls });
      writeForm(values);
      barTitle.textContent = existing ? L.editorEdit : L.editorNew;
      meta.textContent = existing
        ? 'Создано: ' + ui.formatDateTime(existing.createdAt) + ' · Изменено: ' + ui.formatDateTime(existing.updatedAt)
        : '';
      status.textContent = restored ? 'Восстановлен несохранённый черновик.' : '';
      deleteBtn.hidden = !existing;
      editorEl.hidden = false;
      if (bodyInput) bodyInput.scrollTop = 0;
      ui.pushOverlay(closeEditorUI);
      if (!existing && !restored) setTimeout(function () { nameInput.focus(); }, 80);
    }

    /** Вызывается стеком оверлеев: кнопка «Назад», системный «Назад», блокировка, программное закрытие. */
    function closeEditorUI() {
      const state = editing;
      editing = null;
      clearTimeout(draftTimer);
      draftTimer = null;
      if (state && !state.finished && VOID.auth.isUnlocked()) {
        const snap = readForm();
        const keep = isChanged(snap, state.baseline) && !isBlank(snap);
        persistDraft(state, snap).then(function () { return refreshDrafts(); });
        if (keep) VOID.toast(L.draftToast, 'info');
      }
      editorEl.hidden = true;
      clearEditorFields();
    }

    /* ---------- Сохранение ---------- */
    async function saveCurrent() {
      const state = editing;
      if (!state || saving) return;
      const snap = readForm();
      if (isBlank(snap)) { VOID.toast(L.blankError, 'error'); return; }
      if (cfg.validate) {
        const problem = cfg.validate(snap);
        if (problem) { VOID.toast(problem, 'error'); return; }
      }

      saving = true;
      saveBtn.disabled = true;
      try {
        const existing = state.id ? items.find(function (it) { return it.id === state.id; }) : null;
        const rec = {
          id: state.id || undefined,
          tags: useTags ? ui.parseTags(snap.tags) : [],
          category: validCategory(snap.category),
          favorite: useFav ? snap.favorite === true : false,
          createdAt: existing ? existing.createdAt : undefined
        };
        rec[titleKey] = snap[titleKey].trim();
        if (bodyKey) rec[bodyKey] = snap[bodyKey];
        extraFields.forEach(function (f) { rec[f.key] = f.type === 'text' ? snap[f.key].trim() : snap[f.key]; });

        const saved0 = await VOID.db.saveItem(cfg.store, rec);

        state.finished = true; // дальше черновик этой записи не нужен
        if (editing === state) { clearTimeout(draftTimer); draftTimer = null; }

        if (VOID.auth.isUnlocked()) {
          const saved = normalize(saved0);
          if (saved) {
            const idx = items.findIndex(function (it) { return it.id === saved.id; });
            if (idx >= 0) items[idx] = saved; else items.push(saved);
          }
          refreshTagOptions();
          renderList();
        }

        await draftWrite;
        try { await VOID.db.deleteItem('drafts', draftIdFor(state.id)); } catch (_) { /* уже нет */ }

        if (VOID.auth.isUnlocked()) {
          VOID.toast(L.saveToast);
          if (editing === state) ui.requestClose();
          refreshDrafts();
          notifyChange();
          if (cfg.onChange) cfg.onChange();
        }
      } catch (err) {
        if (err && err.message === 'LOCKED') {
          VOID.toast('Хранилище заблокировано. Текст сохранён в черновике.', 'error');
        } else {
          console.error('Save error:', err);
          VOID.toast('Не удалось сохранить. Текст остаётся в редакторе.', 'error');
        }
      } finally {
        saving = false;
        saveBtn.disabled = false;
      }
    }

    /* ---------- Быстрое переключение избранного из списка ---------- */
    async function toggleFavorite(id) {
      const it = items.find(function (x) { return x.id === id; });
      if (!it) return;
      try {
        const rec = Object.assign({}, it, { favorite: !it.favorite });
        const saved = normalize(await VOID.db.saveItem(cfg.store, rec));
        if (!VOID.auth.isUnlocked() || !saved) return;
        const idx = items.findIndex(function (x) { return x.id === id; });
        if (idx >= 0) items[idx] = saved;
        renderList();
      } catch (err) {
        if (!(err && err.message === 'LOCKED')) {
          console.error('Favorite error:', err);
          VOID.toast('Не удалось изменить избранное', 'error');
        }
      }
    }

    /* ---------- Удаление ---------- */
    async function deleteCurrent() {
      const state = editing;
      if (!state || !state.id || saving) return;
      const ok = await ui.confirm({ title: L.deleteTitle, text: L.deleteText, confirmText: 'Удалить' });
      if (!ok || editing !== state) return;
      try {
        state.finished = true;
        clearTimeout(draftTimer);
        draftTimer = null;
        await draftWrite;
        await VOID.db.deleteItem(cfg.store, state.id);
        try { await VOID.db.deleteItem('drafts', draftIdFor(state.id)); } catch (_) { /* уже нет */ }
        items = items.filter(function (it) { return it.id !== state.id; });
        refreshTagOptions();
        renderList();
        VOID.toast(L.deleteToast);
        ui.requestClose();
        refreshDrafts();
        notifyChange();
        if (cfg.onChange) cfg.onChange();
      } catch (err) {
        state.finished = false;
        console.error('Delete error:', err);
        VOID.toast('Не удалось удалить', 'error');
      }
    }

    /* ---------- Отказ от изменений ---------- */
    async function discardChanges() {
      const state = editing;
      if (!state || saving) return;
      if (isChanged(readForm(), state.baseline)) {
        const ok = await ui.confirm({
          title: 'Отбросить изменения?',
          text: 'Несохранённый текст и черновик будут удалены.',
          confirmText: 'Отбросить'
        });
        if (!ok || editing !== state) return;
      }
      state.finished = true;
      clearTimeout(draftTimer);
      draftTimer = null;
      await draftWrite;
      try { await VOID.db.deleteItem('drafts', draftIdFor(state.id)); } catch (_) { /* уже нет */ }
      ui.requestClose();
      refreshDrafts();
    }

    /* =====================================================
       Подключение обработчиков
       ===================================================== */
    newBtn.addEventListener('click', function () {
      openEditor(null, cfg.presetForNew ? cfg.presetForNew() : null);
    });
    searchInput.addEventListener('input', ui.debounce(function () {
      filters.query = searchInput.value;
      renderList();
    }, 150));
    if (tagSelect) tagSelect.addEventListener('change', function () { filters.tag = tagSelect.value; renderList(); });
    if (catFilter) catFilter.addEventListener('change', function () { filters.category = catFilter.value; renderList(); });
    if (favSelect) favSelect.addEventListener('change', function () { filters.favOnly = favSelect.value === '1'; renderList(); });
    sortSelect.addEventListener('change', function () { filters.sort = sortSelect.value; renderList(); });

    listBox.addEventListener('click', function (e) {
      const fav = e.target.closest('[data-fav]');
      if (fav) { toggleFavorite(fav.dataset.fav); return; }
      const card = e.target.closest('[data-id]');
      if (card) openEditor(card.dataset.id);
    });
    draftsBox.addEventListener('click', function (e) {
      const row = e.target.closest('[data-draft-entry]');
      if (row) openEditor(row.dataset.draftEntry || null);
    });

    backBtn.addEventListener('click', function () { ui.requestClose(); });
    saveBtn.addEventListener('click', saveCurrent);
    deleteBtn.addEventListener('click', deleteCurrent);
    discardBtn.addEventListener('click', discardChanges);
    if (favToggle) favToggle.addEventListener('click', function () {
      setFav(!favToggle.classList.contains('on'));
      onEditorInput();
    });
    [nameInput, bodyInput, tagsInput].concat(fieldNodes).forEach(function (n) {
      if (n) { n.addEventListener('input', onEditorInput); n.addEventListener('change', onEditorInput); }
    });
    if (catSelect) catSelect.addEventListener('change', onEditorInput);

    // Сворачивание приложения: сразу сохраняем черновик
    document.addEventListener('visibilitychange', function () { if (document.hidden) flushDraft(); });
    window.addEventListener('pagehide', function () { flushDraft(); });

    // Перед блокировкой ключ ещё жив: даём время записать черновик
    document.addEventListener('void:beforelock', function (e) {
      if (e.detail && typeof e.detail.waitUntil === 'function') e.detail.waitUntil(flushDraft());
    });

    // Блокировка: стираем всё расшифрованное из памяти и с экрана
    document.addEventListener('void:lock', function () {
      editing = null;
      saving = false;
      clearTimeout(draftTimer);
      draftTimer = null;
      items = [];
      loaded = false;
      filters.query = ''; filters.tag = ''; filters.category = ''; filters.favOnly = false;
      filters.sort = cfg.defaultSort || 'updated-desc';
      searchInput.value = '';
      sortSelect.value = filters.sort;
      if (catFilter) catFilter.value = '';
      if (favSelect) favSelect.value = '';
      if (tagSelect) tagSelect.textContent = '';
      listBox.textContent = '';
      draftsBox.textContent = '';
      editorEl.hidden = true;
      clearEditorFields();
      if (cfg.onLock) cfg.onLock();
    });

    document.addEventListener('void:unlock', reload);

    return {
      reload: reload,
      ensureLoaded: ensureLoaded,
      renderList: renderList,
      refreshTagOptions: refreshTagOptions,
      openEditor: openEditor,
      newEntry: function () { return openEditor(null); },
      getItems: function () { return items.map(function (it) { return Object.assign({}, it); }); }
    };
  }

  VOID.createCollection = createCollection;
})();