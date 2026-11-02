/* ===== VOID — Global Search (этап 5) =====
   Поиск по всему приложению. Выполняется локально: записи уже расшифрованы
   в памяти (пока хранилище разблокировано), на диск ничего не пишется,
   запросы нигде не сохраняются.

   Ищет по: заголовкам, текстам, тегам, категориям, названиям треков,
   исполнителям, альбомам, подборкам, названиям и датам событий.
   Результаты группируются по разделам. Нажатие открывает запись в её редакторе. */

(function () {
  'use strict';

  const VOID = window.VOID = window.VOID || {};
  const ui = VOID.ui;
  const el = ui.el;
  const view = document.getElementById('view-search');

  const MAX_PER_GROUP = 20;
  const GROUPS = [
    { id: 'journal', label: 'Дневник' },
    { id: 'archive', label: 'Архив' },
    { id: 'soundscape', label: 'Soundscape' },
    { id: 'timeline', label: 'Хронология' }
  ];
  const KIND_LABEL = { track: 'ТРЕК', artist: 'ИСПОЛНИТЕЛЬ', playlist: 'ПОДБОРКА' };
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const RESULT_FORMS = ['результат', 'результата', 'результатов'];

  let runId = 0;
  const expanded = new Set(); // разделы, раскрытые кнопкой «Показать все»

  /* ---------- Помощники ---------- */
  function plural(n, forms) {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    if (a > 10 && a < 20) return forms[2];
    if (b > 1 && b < 5) return forms[1];
    if (b === 1) return forms[0];
    return forms[2];
  }

  function longDate(iso) {
    if (!DATE_RE.test(iso)) return '';
    const p = iso.split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]))
      .toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  /** "Идея #Работа" -> ["идея", "работа"]. Все слова запроса должны встретиться в записи. */
  function tokensOf(q) {
    return String(q).toLowerCase().split(/\s+/)
      .map(function (t) { return t.replace(/^#+/, ''); })
      .filter(Boolean);
  }

  /** Строка, по которой ищем, для одной записи. */
  function haystack(groupId, it) {
    const p = [it.title, it.body, (it.tags || []).join(' '), it.category];
    if (groupId === 'soundscape') p.push(it.artist, it.album, it.playlist);
    if (groupId === 'timeline') p.push(it.date, longDate(it.date));
    return p.filter(Boolean).join('\n').toLowerCase();
  }

  /** Подсветка найденных слов. Текст вставляется только как текстовые узлы и <mark>. */
  function highlight(text, tokens) {
    const frag = document.createDocumentFragment();
    const lower = text.toLowerCase();
    if (!text || !tokens.length || lower.length !== text.length) {
      frag.appendChild(document.createTextNode(text));
      return frag;
    }
    const flags = new Uint8Array(text.length);
    tokens.forEach(function (t) {
      let from = 0;
      let idx;
      while ((idx = lower.indexOf(t, from)) !== -1) {
        for (let i = idx; i < idx + t.length; i++) flags[i] = 1;
        from = idx + t.length;
      }
    });
    let i = 0;
    while (i < text.length) {
      const on = flags[i] === 1;
      let j = i;
      while (j < text.length && (flags[j] === 1) === on) j++;
      const piece = text.slice(i, j);
      frag.appendChild(on ? el('mark', { text: piece }) : document.createTextNode(piece));
      i = j;
    }
    return frag;
  }

  /** Фрагмент текста вокруг первого совпадения. */
  function context(text, tokens) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    const lower = s.toLowerCase();
    let best = -1;
    tokens.forEach(function (t) {
      const i = lower.indexOf(t);
      if (i !== -1 && (best === -1 || i < best)) best = i;
    });
    if (best < 50) return ui.snippet(s, 140);
    const start = best - 40;
    const piece = s.slice(start, start + 140).trim();
    return '…' + piece + (start + 140 < s.length ? '…' : '');
  }

  /* ---------- Интерфейс ---------- */
  const input = el('input', { class: 'input', type: 'search', placeholder: 'Искать везде…',
    maxlength: 100, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Глобальный поиск' });
  const scope = el('select', { class: 'select', 'aria-label': 'Раздел поиска' });
  scope.appendChild(el('option', { value: '', text: 'Везде' }));
  GROUPS.forEach(function (g) { scope.appendChild(el('option', { value: g.id, text: g.label })); });
  const info = el('div', { class: 'search-info', 'aria-live': 'polite' });
  const results = el('div', { class: 'search-results' });

  view.textContent = '';
  view.append(el('div', { class: 'toolbar' }, [input, scope]), info, results);

  function showHint() {
    info.textContent = '';
    results.textContent = '';
    results.appendChild(ui.emptyBlock('Введите запрос',
      'Поиск идёт по заголовкам, текстам, тегам, категориям, музыке и событиям. Запросы нигде не сохраняются.'));
  }

  function hitLabel(groupId, it) {
    if (groupId === 'archive') return it.category;
    if (groupId === 'soundscape') return KIND_LABEL[it.kind] || '';
    if (groupId === 'timeline') return (longDate(it.date) || 'Без даты') + (it.category ? ' · ' + it.category : '');
    return ui.formatDate(it.createdAt);
  }

  function buildHit(groupId, it, tokens) {
    const card = el('button', { class: 'list-item list-item--click', type: 'button',
      'data-open': it.id, 'data-group': groupId });
    const label = hitLabel(groupId, it);
    if (label) card.appendChild(el('div', { class: 'card-cat', text: label }));

    const title = el('div', { class: 'list-item__title' });
    title.appendChild(highlight(it.title || 'Без названия', tokens));
    card.appendChild(title);

    if (groupId === 'soundscape') {
      const line = [it.artist, it.album, it.playlist].filter(Boolean).join(' · ');
      if (line) {
        const sub = el('div', { class: 'card-sub' });
        sub.appendChild(highlight(line, tokens));
        card.appendChild(sub);
      }
    }
    const ctx = context(it.body, tokens);
    if (ctx) {
      const sn = el('div', { class: 'card-snippet' });
      sn.appendChild(highlight(ctx, tokens));
      card.appendChild(sn);
    }
    if (it.tags && it.tags.length) card.appendChild(ui.tagChips(it.tags));
    return card;
  }

  function renderResults(groups, tokens) {
    results.textContent = '';
    let total = 0;
    groups.forEach(function (g) { total += g.hits.length; });
    if (!total) {
      info.textContent = '';
      results.appendChild(ui.emptyBlock('Ничего не найдено', 'Попробуйте другое слово или выберите «Везде».'));
      return;
    }
    info.textContent = 'Найдено: ' + total + ' ' + plural(total, RESULT_FORMS);

    groups.forEach(function (g) {
      if (!g.hits.length) return;
      const isOpen = expanded.has(g.id);
      const shown = isOpen ? g.hits : g.hits.slice(0, MAX_PER_GROUP);
      const box = el('section', { class: 'search-group' });
      box.appendChild(el('h2', { class: 'section-title search-group__title', text: g.label + ' · ' + g.hits.length }));
      const list = el('div', { class: 'list' });
      shown.forEach(function (it) { list.appendChild(buildHit(g.id, it, tokens)); });
      box.appendChild(list);
      if (!isOpen && g.hits.length > MAX_PER_GROUP) {
        box.appendChild(el('button', { class: 'btn btn--ghost btn--block', type: 'button',
          'data-more': g.id, text: 'Показать все (' + g.hits.length + ')' }));
      }
      results.appendChild(box);
    });
  }

  /* ---------- Поиск ---------- */
  async function ensureAll() {
    await Promise.all(GROUPS.map(function (g) {
      const coll = VOID[g.id];
      return coll ? Promise.resolve(coll.ensureLoaded()).catch(function () {}) : null;
    }));
  }

  async function run() {
    const id = ++runId;
    if (!VOID.auth || !VOID.auth.isUnlocked()) return;
    const tokens = tokensOf(input.value);
    if (!tokens.length) { showHint(); return; }

    await ensureAll();
    if (id !== runId || !VOID.auth.isUnlocked()) return; // запрос устарел или хранилище заблокировано

    const groups = [];
    GROUPS.forEach(function (g) {
      if (scope.value && scope.value !== g.id) return;
      const coll = VOID[g.id];
      const items = coll ? coll.getItems() : [];
      const hits = [];
      items.forEach(function (it) {
        const hay = haystack(g.id, it);
        if (!tokens.every(function (t) { return hay.includes(t); })) return;
        const title = (it.title || '').toLowerCase();
        hits.push({ it: it, titleHit: tokens.every(function (t) { return title.includes(t); }) });
      });
      // Сначала совпадения в заголовке, потом более свежие
      hits.sort(function (a, b) {
        return (b.titleHit - a.titleHit) || (b.it.updatedAt - a.it.updatedAt);
      });
      groups.push({ id: g.id, label: g.label, hits: hits.map(function (h) { return h.it; }) });
    });
    renderResults(groups, tokens);
  }

  /* ---------- Обработчики ---------- */
  input.addEventListener('input', ui.debounce(function () { expanded.clear(); run(); }, 200));
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') input.blur(); });
  scope.addEventListener('change', function () { expanded.clear(); run(); });

  results.addEventListener('click', function (e) {
    const more = e.target.closest('[data-more]');
    if (more) { expanded.add(more.dataset.more); run(); return; }
    const hit = e.target.closest('[data-open]');
    if (!hit) return;
    const coll = VOID[hit.dataset.group];
    if (coll) coll.openEditor(hit.dataset.open);
  });

  window.addEventListener('hashchange', function () {
    if (location.hash !== '#search' || !VOID.auth || !VOID.auth.isUnlocked()) return;
    if (input.value.trim()) run(); // данные могли измениться, пока были в другом разделе
    else setTimeout(function () { input.focus(); }, 80);
  });

  // После сохранения или удаления записи обновляем результаты
  document.addEventListener('void:datachange', function () {
    if (location.hash === '#search' && input.value.trim()) run();
  });

  document.addEventListener('void:unlock', showHint);

  // Блокировка: убираем запрос и результаты с экрана
  document.addEventListener('void:lock', function () {
    runId++;
    input.value = '';
    scope.value = '';
    expanded.clear();
    showHint();
  });

  showHint();
  VOID.search = { run: run };
})();