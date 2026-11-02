/* ===== VOID — Дневник (этап 3) =====
   Описывает поля и подписи Дневника; вся работа выполняется общим движком collection.js. */

(function () {
  'use strict';

  const VOID = window.VOID = window.VOID || {};

  const journal = VOID.journal = VOID.createCollection({
    store: 'journal',
    draftKind: 'journal',
    viewId: 'view-journal',
    categories: null,
    labels: {
      name: 'Дневник',
      newButton: 'Новая запись',
      searchPlaceholder: 'Поиск по заголовкам, тексту и тегам',
      emptyTitle: 'Дневник пуст',
      emptyText: 'Нажмите «Новая запись», чтобы создать первую.',
      editorNew: 'Новая запись',
      editorEdit: 'Редактирование',
      editorLabel: 'Редактор записи',
      titlePlaceholder: 'Заголовок',
      bodyPlaceholder: 'Что у вас на уме?',
      bodyLabel: 'Текст записи',
      saveToast: 'Запись сохранена',
      deleteToast: 'Запись удалена',
      deleteButton: 'Удалить запись',
      deleteTitle: 'Удалить запись?',
      deleteText: 'Запись будет удалена без возможности восстановления.',
      blankError: 'Запись пуста: добавьте заголовок или текст',
      draftToast: 'Изменения сохранены как черновик'
    }
  });

  // Источник данных для блока «Последние записи» на главной (заменяет версию из database.js)
  VOID.providers = VOID.providers || {};
  VOID.providers.recent = async function (limit) {
    await journal.ensureLoaded();
    return journal.getItems()
      .sort(function (a, b) { return b.updatedAt - a.updatedAt; })
      .slice(0, limit)
      .map(function (it) {
        return { id: it.id, title: it.title || 'Без названия', meta: VOID.ui.formatDateTime(it.updatedAt) };
      });
  };
})();