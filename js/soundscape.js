/* ===== VOID — Soundscape (этап 4) =====
   Каталог музыкальных предпочтений: треки, исполнители, подборки.
   Встроенного проигрывателя нет (по ТЗ). Всё хранится в одном зашифрованном разделе
   soundscape; тип записи (track / artist / playlist) хранится внутри шифрованного блока.
   Вкладки — это фильтр по типу поверх общего движка collection.js. */

(function () {
  'use strict';

  const VOID = window.VOID = window.VOID || {};
  const ui = VOID.ui;
  const el = ui.el;

  const KINDS = [
    { id: 'track',    tab: 'Треки',      one: 'трек',      titleLabel: 'Название трека',     bodyPh: 'Описание, впечатления, заметки' },
    { id: 'artist',   tab: 'Исполнители', one: 'исполнитель', titleLabel: 'Имя исполнителя',   bodyPh: 'О чём этот исполнитель для вас' },
    { id: 'playlist', tab: 'Подборки',   one: 'подборка',  titleLabel: 'Название подборки',  bodyPh: 'Идея и настроение подборки' }
  ];
  const KIND_IDS = KINDS.map(function (k) { return k.id; });
  const KIND_LABEL = { track: 'ТРЕК', artist: 'ИСПОЛНИТЕЛЬ', playlist: 'ПОДБОРКА' };
  const NEW_BUTTON = { track: 'Новый трек', artist: 'Новый исполнитель', playlist: 'Новая подборка' };

  let currentKind = 'track';
  let coll = null;

  /* ---------- Вкладки ---------- */
  const tabButtons = {};
  const tabs = el('div', { class: 'tabs', role: 'tablist' });
  KINDS.forEach(function (k) {
    const b = el('button', { class: 'tab' + (k.id === currentKind ? ' active' : ''), type: 'button',
      role: 'tab', 'data-kind': k.id, text: k.tab, 'aria-selected': k.id === currentKind ? 'true' : 'false' });
    tabButtons[k.id] = b;
    tabs.appendChild(b);
  });

  function setKind(kind) {
    if (!KIND_IDS.includes(kind) || kind === currentKind) return;
    currentKind = kind;
    Object.keys(tabButtons).forEach(function (id) {
      const on = id === kind;
      tabButtons[id].classList.toggle('active', on);
      tabButtons[id].setAttribute('aria-selected', on ? 'true' : 'false');
    });
    updateNewButton();
    if (coll) { coll.refreshTagOptions(); coll.renderList(); }
  }

  tabs.addEventListener('click', function (e) {
    const b = e.target.closest('[data-kind]');
    if (b) setKind(b.dataset.kind);
  });

  /** Подпись кнопки «Новый …» зависит от вкладки. */
  function updateNewButton() {
    const btn = document.querySelector('#view-soundscape .toolbar .btn--primary span');
    if (btn) btn.textContent = NEW_BUTTON[currentKind];
  }

  /* ---------- Подборки, доступные для выбора у трека ---------- */
  function playlistNames(items) {
    const names = [];
    items.forEach(function (it) {
      if (it.kind === 'playlist' && it.title && !names.includes(it.title)) names.push(it.title);
    });
    return names.sort(function (a, b) { return a.localeCompare(b, 'ru'); });
  }

  /** Перед открытием редактора подстраиваем подписи и поля под тип записи. */
  function adaptEditor(ctx) {
    const kind = ctx.existing ? ctx.existing.kind : currentKind;
    const k = KINDS.find(function (x) { return x.id === kind; });
    document.querySelector('#view-soundscape'); // раздел существует всегда
    const f = ctx.fields;
    const isTrack = kind === 'track';
    const isArtist = kind === 'artist';
    f.artist.hidden = isArtist;
    f.artist.placeholder = isTrack ? 'Исполнитель' : 'Исполнитель / автор (необязательно)';
    f.album.hidden = !isTrack;
    f.playlist.hidden = !isTrack;
    // Список подборок для выбора через datalist
    let dl = document.getElementById('sc-playlists');
    if (!dl) { dl = el('datalist', { id: 'sc-playlists' }); document.body.appendChild(dl); }
    dl.textContent = '';
    playlistNames(ctx.items).forEach(function (n) { dl.appendChild(el('option', { value: n })); });
    f.playlist.setAttribute('list', 'sc-playlists');
    // Подписи
    const nameInput = f.artist.closest('.editor__body').querySelector('.editor__name');
    nameInput.placeholder = k.titleLabel;
    nameInput.setAttribute('aria-label', k.titleLabel);
    const area = f.body;
    if (area) area.placeholder = k.bodyPh;
  }

  coll = VOID.soundscape = VOID.createCollection({
    store: 'soundscape',
    draftKind: 'soundscape',
    viewId: 'view-soundscape',
    categories: null,
    tags: true,
    favorite: true,
    topNode: tabs,
    fields: [
      { key: 'kind', type: 'select', label: 'Тип', options: KIND_IDS.map(function (id) { return [id, id]; }) },
      { key: 'artist', type: 'text', label: 'Исполнитель', placeholder: 'Исполнитель', maxLength: 200 },
      { key: 'album', type: 'text', label: 'Альбом', placeholder: 'Название альбома', maxLength: 200 },
      { key: 'playlist', type: 'text', label: 'Подборка', placeholder: 'Подборка (выберите или введите)', maxLength: 200 }
    ],
    bodyKey: 'body',
    sorts: [
      ['updated-desc', 'Недавно изменённые'],
      ['created-desc', 'Сначала новые'],
      ['title-asc', 'По названию А–Я']
    ],
    filter: function (it) { return it.kind === currentKind; },
    defaults: function () { return { kind: currentKind }; },
    presetForNew: function () { return { kind: currentKind }; },
    emptyFor: function () {
      const word = { track: 'Треков пока нет', artist: 'Исполнителей пока нет', playlist: 'Подборок пока нет' }[currentKind];
      return { title: word, text: 'Нажмите кнопку выше, чтобы добавить первую запись.' };
    },
    beforeOpen: adaptEditor,
    card: function (it) {
      const card = el('button', { class: 'list-item list-item--click', type: 'button', 'data-id': it.id });
      card.appendChild(el('div', { class: 'card-cat', text: KIND_LABEL[it.kind] || '' }));
      card.appendChild(el('div', { class: 'list-item__title', text: it.title || 'Без названия' }));
      const line = [it.artist, it.album].filter(Boolean).join(' · ');
      if (line) card.appendChild(el('div', { class: 'card-sub', text: line }));
      if (it.playlist) card.appendChild(el('div', { class: 'card-sub', text: 'Подборка: ' + it.playlist }));
      const sn = ui.snippet(it.body, 120);
      if (sn) card.appendChild(el('div', { class: 'card-snippet', text: sn }));
      if (it.tags.length) card.appendChild(ui.tagChips(it.tags));
      card.appendChild(el('div', { class: 'list-item__meta', text: 'Добавлено ' + ui.formatDate(it.createdAt) }));
      return card;
    },
    onLock: function () {
      currentKind = 'track';
      Object.keys(tabButtons).forEach(function (id) {
        tabButtons[id].classList.toggle('active', id === 'track');
        tabButtons[id].setAttribute('aria-selected', id === 'track' ? 'true' : 'false');
      });
      const dl = document.getElementById('sc-playlists');
      if (dl) dl.textContent = '';
      updateNewButton();
    },
    validate: function (snap) {
      if (snap.kind === 'track' && !snap.title.trim()) return 'Укажите название трека';
      if (!snap.title.trim()) return 'Укажите название';
      return '';
    },
    labels: {
      name: 'Soundscape',
      newButton: 'Новый трек',
      searchPlaceholder: 'Поиск по названиям, исполнителям, альбомам',
      emptyTitle: 'Пока пусто',
      emptyText: 'Добавьте первую запись.',
      editorNew: 'Новая запись',
      editorEdit: 'Редактирование',
      editorLabel: 'Редактор записи Soundscape',
      titlePlaceholder: 'Название',
      bodyPlaceholder: 'Описание',
      bodyLabel: 'Описание',
      saveToast: 'Сохранено',
      deleteToast: 'Запись удалена',
      deleteButton: 'Удалить запись',
      deleteTitle: 'Удалить запись?',
      deleteText: 'Запись будет удалена без возможности восстановления.',
      blankError: 'Запись пуста: добавьте название',
      draftToast: 'Изменения сохранены как черновик'
    }
  });

  updateNewButton();
})();