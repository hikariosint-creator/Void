/* ===== VOID — Timeline (этап 4) =====
   Хронология личных событий: название, описание, дата, категория.
   События показываются на вертикальной линии, сгруппированные по годам,
   сортировка по дате события (от новых к старым или наоборот).
   Вся работа с данными и редактором — в общем движке collection.js. */

(function () {
  'use strict';

  const VOID = window.VOID = window.VOID || {};
  const ui = VOID.ui;
  const el = ui.el;

  const CATEGORIES = ['LIFE', 'WORK', 'PEOPLE', 'TRAVEL', 'HEALTH', 'MILESTONE', 'OTHER'];
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  /** Сегодняшняя дата в формате ГГГГ-ММ-ДД по местному времени (не UTC). */
  function todayISO() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  /** "2026-11-02" -> "2 ноября 2026" (разбор вручную, чтобы не зависеть от часового пояса). */
  function formatEventDate(iso) {
    if (!DATE_RE.test(iso)) return 'Без даты';
    const p = iso.split('-');
    const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  VOID.timeline = VOID.createCollection({
    store: 'timeline',
    draftKind: 'timeline',
    viewId: 'view-timeline',
    titleKey: 'title',
    bodyKey: 'body',
    categories: CATEGORIES,
    defaultCategory: 'LIFE',
    tags: true,
    favorite: false,
    dateKey: 'date',
    defaultSort: 'date-desc',
    sorts: [
      ['date-desc', 'Сначала недавние'],
      ['date-asc', 'Сначала давние']
    ],
    fields: [
      { key: 'date', type: 'date', label: 'Дата события' }
    ],
    defaults: function () { return { date: todayISO() }; },
    validate: function (snap) {
      if (!DATE_RE.test(snap.date)) return 'Укажите дату события';
      if (!snap.title.trim()) return 'Укажите название события';
      return '';
    },
    // Карточка события на линии времени
    card: function (it) {
      const card = el('button', { class: 'list-item list-item--click', type: 'button', 'data-id': it.id });
      card.appendChild(el('div', { class: 'tl-date', text: formatEventDate(it.date) + (it.category ? ' · ' + it.category : '') }));
      card.appendChild(el('div', { class: 'list-item__title', text: it.title || 'Без названия' }));
      const sn = ui.snippet(it.body, 140);
      if (sn) card.appendChild(el('div', { class: 'card-snippet', text: sn }));
      if (it.tags.length) card.appendChild(ui.tagChips(it.tags));
      return card;
    },
    // Вертикальная линия с группировкой по годам
    renderList: function (shown, box, buildNode) {
      let ul = null;
      let year = null;
      shown.forEach(function (it) {
        const y = DATE_RE.test(it.date) ? it.date.slice(0, 4) : 'Без даты';
        if (y !== year) {
          year = y;
          box.appendChild(el('div', { class: 'tl-year', text: y }));
          ul = el('ul', { class: 'tl' });
          box.appendChild(ul);
        }
        ul.appendChild(el('li', { class: 'tl-item' }, [buildNode(it)]));
      });
    },
    emptyFor: function () {
      return { title: 'Хронология пуста', text: 'Нажмите «Новое событие», чтобы добавить первое.' };
    },
    labels: {
      name: 'Хронология',
      newButton: 'Новое событие',
      searchPlaceholder: 'Поиск по названиям, описаниям и тегам',
      emptyTitle: 'Хронология пуста',
      emptyText: 'Добавьте первое событие.',
      editorNew: 'Новое событие',
      editorEdit: 'Редактирование',
      editorLabel: 'Редактор события',
      titlePlaceholder: 'Название события',
      bodyPlaceholder: 'Описание',
      bodyLabel: 'Описание события',
      saveToast: 'Событие сохранено',
      deleteToast: 'Событие удалено',
      deleteButton: 'Удалить событие',
      deleteTitle: 'Удалить событие?',
      deleteText: 'Событие будет удалено без возможности восстановления.',
      blankError: 'Событие пусто: добавьте название',
      draftToast: 'Изменения сохранены как черновик'
    }
  });
})();