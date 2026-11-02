/* ===== VOID — общие помощники интерфейса (этап 3) =====
   - el(), icon(): безопасное создание элементов (пользовательский текст только через textContent)
   - работа с тегами и датами
   - стек «оверлеев» (редакторы, окно подтверждения), чтобы кнопка «Назад» на Android
     закрывала редактор, а не выбрасывала пользователя из приложения
   - confirm(): окно подтверждения опасных действий */

(function () {
  'use strict';

  const VOID = window.VOID = window.VOID || {};
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MAX_TAGS = 10;
  const MAX_TAG_LENGTH = 30;

  /* ---------- Создание элементов ---------- */
  /** el('div', { class: 'x', text: 'Привет', 'data-id': '1' }, [дети]).
      Ключ text записывается через textContent, остальное — обычные атрибуты. */
  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        if (k === 'text') node.textContent = String(props[k]);
        else if (k === 'class') node.className = props[k];
        else node.setAttribute(k, props[k]);
      });
    }
    (children || []).forEach(function (c) { if (c) node.append(c); });
    return node;
  }

  /** Иконка из набора в index.html (symbol с id="i-имя"). */
  function icon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'icon');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '#i-' + name);
    svg.appendChild(use);
    return svg;
  }

  function emptyBlock(title, text) {
    return el('div', { class: 'empty' }, [
      el('div', { class: 'empty__title', text: title }),
      text ? el('p', { class: 'empty__text', text: text }) : null
    ]);
  }

  /* ---------- Текст и даты ---------- */
  function snippet(text, max) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max).trimEnd() + '…' : s;
  }

  function formatDate(ts) {
    if (!Number.isFinite(ts) || ts <= 0) return '—';
    return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function formatDateTime(ts) {
    if (!Number.isFinite(ts) || ts <= 0) return '—';
    return new Date(ts).toLocaleString('ru-RU',
      { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function formatTime(ts) {
    return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }

  /* ---------- Теги ---------- */
  /** "Идея, #работа; Работа" -> ["идея", "работа"]: без повторов, максимум 10 штук по 30 символов. */
  function parseTags(input) {
    const out = [];
    String(input || '').split(/[,;#\n]+/).forEach(function (part) {
      const tag = part.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, MAX_TAG_LENGTH).trim();
      if (tag && !out.includes(tag) && out.length < MAX_TAGS) out.push(tag);
    });
    return out;
  }

  function tagsToString(tags) {
    return Array.isArray(tags) ? tags.join(', ') : '';
  }

  function tagChips(tags) {
    const box = el('div', { class: 'chips' });
    tags.forEach(function (t) { box.appendChild(el('span', { class: 'chip', text: '#' + t })); });
    return box;
  }

  function debounce(fn, ms) {
    let timer = null;
    return function () {
      const args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(null, args); }, ms);
    };
  }

  /* ---------- Стек оверлеев и кнопка «Назад» ---------- */
  const overlays = []; // каждый элемент: { close: функция, pushed: bool, closing: bool }

  /** Открывает оверлей: добавляет запись в историю браузера, чтобы «Назад» закрывал его. */
  function pushOverlay(closeFn) {
    let pushed = false;
    try { history.pushState({ voidOverlay: true }, ''); pushed = true; } catch (_) { /* история недоступна */ }
    overlays.push({ close: closeFn, pushed: pushed, closing: false });
  }

  /** Закрывает верхний оверлей (кнопка в интерфейсе или программно). */
  function requestClose() {
    const top = overlays[overlays.length - 1];
    if (!top || top.closing) return;
    top.closing = true;
    if (!top.pushed) { overlays.pop(); top.close(); return; }
    try { history.back(); } catch (_) { overlays.pop(); top.close(); return; }
    // Запасной вариант: если браузер не прислал popstate, закрываем сами
    setTimeout(function () {
      if (overlays[overlays.length - 1] === top) { overlays.pop(); top.close(); }
    }, 400);
  }

  /** Закрывает всё сразу (при блокировке). */
  function closeAllOverlays() {
    while (overlays.length) { overlays.pop().close(); }
  }

  window.addEventListener('popstate', function () {
    const top = overlays.pop();
    if (top) top.close();
  });
  document.addEventListener('void:lock', closeAllOverlays);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') requestClose(); });

  /* ---------- Окно подтверждения ---------- */
  /** ui.confirm({ title, text, confirmText, cancelText }) -> Promise<boolean> */
  function confirmDialog(opts) {
    const modal = document.getElementById('modal');
    if (!modal) return Promise.resolve(window.confirm(opts.text || 'Подтвердить?'));

    return new Promise(function (resolve) {
      const okBtn = document.getElementById('modal-ok');
      const cancelBtn = document.getElementById('modal-cancel');
      let result = false;

      document.getElementById('modal-title').textContent = opts.title || 'Подтвердите действие';
      document.getElementById('modal-text').textContent = opts.text || '';
      okBtn.textContent = opts.confirmText || 'OK';
      cancelBtn.textContent = opts.cancelText || 'Отмена';

      const onOk = function () { result = true; requestClose(); };
      const onCancel = function () { result = false; requestClose(); };
      const onBackdrop = function (e) { if (e.target === modal) onCancel(); };

      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      modal.addEventListener('click', onBackdrop);
      modal.hidden = false;

      pushOverlay(function () {
        modal.hidden = true;
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        modal.removeEventListener('click', onBackdrop);
        resolve(result);
      });
      setTimeout(function () { cancelBtn.focus(); }, 30); // фокус на безопасной кнопке
    });
  }

  VOID.ui = {
    el: el, icon: icon, emptyBlock: emptyBlock,
    snippet: snippet, formatDate: formatDate, formatDateTime: formatDateTime, formatTime: formatTime,
    parseTags: parseTags, tagsToString: tagsToString, tagChips: tagChips, debounce: debounce,
    pushOverlay: pushOverlay, requestClose: requestClose, closeAllOverlays: closeAllOverlays,
    confirm: confirmDialog
  };
})();