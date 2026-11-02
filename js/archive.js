/* ===== VOID — Memory Archive (этап 3) =====
   Карточки с категориями и тегами. Вся работа выполняется общим движком collection.js. */

(function () {
  'use strict';

  const VOID = window.VOID = window.VOID || {};

  VOID.archive = VOID.createCollection({
    store: 'archive',
    draftKind: 'archive',
    viewId: 'view-archive',
    categories: ['IDEAS', 'MEMORIES', 'PROJECTS', 'NOTES', 'PERSONAL', 'OTHER'],
    defaultCategory: 'NOTES',
    labels: {
      name: 'Архив',
      newButton: 'Новый материал',
      searchPlaceholder: 'Поиск по названиям, описаниям и тегам',
      emptyTitle: 'Архив пуст',
      emptyText: 'Нажмите «Новый материал», чтобы добавить первую карточку.',
      editorNew: 'Новый материал',
      editorEdit: 'Редактирование',
      editorLabel: 'Редактор материала',
      titlePlaceholder: 'Название',
      bodyPlaceholder: 'Описание',
      bodyLabel: 'Описание материала',
      saveToast: 'Материал сохранён',
      deleteToast: 'Материал удалён',
      deleteButton: 'Удалить материал',
      deleteTitle: 'Удалить материал?',
      deleteText: 'Карточка будет удалена без возможности восстановления.',
      blankError: 'Карточка пуста: добавьте название или описание',
      draftToast: 'Изменения сохранены как черновик'
    }
  });
})();