/* ===== VOID — Statistics (этап 5) =====
   Вся статистика считается ТОЛЬКО на устройстве по реальным данным четырёх разделов.
   Ничего не выдумывается: никаких «серий», «рекордов» и фиктивной активности.

   Что именно считается:
   - количество записей в каждом разделе;
   - «активные дни»: дни, в которые хотя бы одна из существующих записей была создана
     или в последний раз изменена. Это следует из дат createdAt и updatedAt;
     удалённые записи и промежуточные правки не сохраняются и в статистику не входят;
   - последняя активность: самая свежая дата создания или изменения;
   - слова: число слов в текстах Дневника.
   Расшифрованные тексты не копируются: после подсчёта остаются только числа. */

(function () {
  'use strict';

  const VOID = window.VOID = window.VOID || {};
  const ui = VOID.ui;
  const el = ui.el;
  const view = document.getElementById('view-statistics');

  const SECTIONS = [
    { id: 'journal', label: 'Дневник' },
    { id: 'archive', label: 'Архив' },
    { id: 'soundscape', label: 'Soundscape' },
    { id: 'timeline', label: 'Хронология' }
  ];
  const RANGES = [['14', '14 дней'], ['30', '30 дней'], ['12m', '12 месяцев']];
  const RECORD_FORMS = ['запись', 'записи', 'записей'];

  let range = '14';   // выбранный период графика
  let cache = null;   // только агрегированные числа; очищается при блокировке
  let runId = 0;      // защита от устаревших результатов

  /* ---------- Помощники ---------- */
  function pad(n) { return String(n).padStart(2, '0'); }

  /** Ключ дня по местному времени: ГГГГ-ММ-ДД. */
  function dayKey(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  /** Правильное склонение: 1 запись, 2 записи, 5 записей. */
  function plural(n, forms) {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    if (a > 10 && a < 20) return forms[2];
    if (b > 1 && b < 5) return forms[1];
    if (b === 1) return forms[0];
    return forms[2];
  }

  function relativeDays(ts) {
    const now = new Date();
    const d = new Date(ts);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diff = Math.round((today - day) / 86400000);
    if (diff <= 0) return 'сегодня';
    if (diff === 1) return 'вчера';
    return diff + ' ' + plural(diff, ['день', 'дня', 'дней']) + ' назад';
  }

  /* ---------- Сбор и подсчёт ---------- */
  async function collect() {
    const data = {};
    for (const s of SECTIONS) {
      const coll = VOID[s.id];
      if (!coll) { data[s.id] = []; continue; }
      await coll.ensureLoaded();
      data[s.id] = coll.getItems();
    }
    return data;
  }

  function compute(data) {
    const dayMap = new Map(); // день -> сколько записей создано или изменено
    const counts = {};
    let last = 0;
    let total = 0;

    SECTIONS.forEach(function (s) {
      counts[s.id] = data[s.id].length;
      total += data[s.id].length;
      data[s.id].forEach(function (it) {
        const days = new Set();
        if (it.createdAt > 0) days.add(dayKey(it.createdAt));
        if (it.updatedAt > 0) days.add(dayKey(it.updatedAt));
        days.forEach(function (k) { dayMap.set(k, (dayMap.get(k) || 0) + 1); });
        last = Math.max(last, it.createdAt, it.updatedAt);
      });
    });

    let words = 0;
    data.journal.forEach(function (it) {
      const m = it.body.match(/\S+/g);
      if (m) words += m.length;
    });

    const kinds = { track: 0, artist: 0, playlist: 0 };
    data.soundscape.forEach(function (it) { if (kinds[it.kind] !== undefined) kinds[it.kind]++; });

    return { counts: counts, total: total, dayMap: dayMap, activeDays: dayMap.size,
             last: last, words: words, kinds: kinds };
  }

  /** Данные для столбцов графика: по дням (14/30) или по месяцам (12m). */
  function buildSeries(rangeId, dayMap) {
    const now = new Date();
    const out = [];
    if (rangeId === '12m') {
      const sums = new Map();
      dayMap.forEach(function (v, k) {
        const m = k.slice(0, 7);
        sums.set(m, (sums.get(m) || 0) + v);
      });
      for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const key = d.getFullYear() + '-' + pad(d.getMonth() + 1);
        out.push({
          value: sums.get(key) || 0,
          short: d.toLocaleDateString('ru-RU', { month: 'short' }).replace('.', '').slice(0, 3),
          full: d.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })
        });
      }
    } else {
      const n = Number(rangeId);
      for (let i = n - 1; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        out.push({
          value: dayMap.get(dayKey(d.getTime())) || 0,
          short: String(d.getDate()),
          full: d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
        });
      }
    }
    return out;
  }

  /* ---------- Отрисовка ---------- */
  function statCard(num, label, sub) {
    return el('div', { class: 'stat-card' }, [
      el('div', { class: 'stat-card__num', text: String(num) }),
      el('div', { class: 'stat-card__label', text: label }),
      sub ? el('div', { class: 'stat-card__sub', text: sub }) : null
    ]);
  }

  function renderChart(box, c) {
    box.textContent = '';
    const series = buildSeries(range, c.dayMap);
    const max = Math.max(1, Math.max.apply(null, series.map(function (s) { return s.value; })));
    const sum = series.reduce(function (a, s) { return a + s.value; }, 0);

    const chart = el('div', { class: 'chart', role: 'group', 'aria-label': 'График активности' });
    chart.style.gridTemplateColumns = 'repeat(' + series.length + ', 1fr)';
    const readout = el('div', { class: 'chart__readout', 'aria-live': 'polite',
      text: 'За период: ' + sum + ' · нажмите на столбец, чтобы увидеть значение' });

    series.forEach(function (s, i) {
      const bar = el('div', { class: 'chart__bar' + (s.value ? '' : ' chart__bar--zero') });
      if (s.value) bar.style.height = Math.max(3, Math.round(s.value / max * 100)) + '%';
      const showLabel = range !== '30' || i % 5 === 0 || i === series.length - 1;
      chart.appendChild(el('button', { class: 'chart__col', type: 'button', 'data-i': String(i),
        'aria-label': s.full + ': ' + s.value }, [
        el('div', { class: 'chart__track' }, [bar]),
        el('span', { class: 'chart__label', text: showLabel ? s.short : '' })
      ]));
    });

    chart.addEventListener('click', function (e) {
      const col = e.target.closest('.chart__col');
      if (!col) return;
      const prev = chart.querySelector('.sel');
      if (prev) prev.classList.remove('sel');
      col.classList.add('sel');
      const s = series[Number(col.dataset.i)];
      readout.textContent = s.full + ': ' + s.value + ' ' + plural(s.value, RECORD_FORMS);
    });

    box.append(chart, readout);
  }

  function render(c) {
    view.textContent = '';

    // Карточки
    const musicSub = 'треков ' + c.kinds.track + ' · исполнителей ' + c.kinds.artist + ' · подборок ' + c.kinds.playlist;
    const lastCard = el('div', { class: 'stat-card stat-card--wide' }, [
      el('div', { class: 'stat-card__label', text: 'Последняя активность' }),
      el('div', { class: 'stat-card__value', text: c.last ? ui.formatDateTime(c.last) : '—' }),
      el('div', { class: 'stat-card__sub', text: c.last ? relativeDays(c.last) : 'Активности пока нет' })
    ]);
    view.appendChild(el('div', { class: 'stat-grid' }, [
      statCard(c.counts.journal, 'Записи дневника'),
      statCard(c.counts.archive, 'Архив'),
      statCard(c.counts.timeline, 'События'),
      statCard(c.counts.soundscape, 'Музыка', musicSub),
      statCard(c.activeDays, 'Активных дней'),
      statCard(c.words, 'Слов в дневнике'),
      lastCard
    ]));

    if (c.total === 0) {
      view.appendChild(ui.emptyBlock('Данных пока нет',
        'Графики появятся, когда вы создадите первые записи.'));
    } else {
      // График активности
      view.appendChild(el('h2', { class: 'section-title', text: 'Активность' }));
      const chartBox = el('div');
      const tabs = el('div', { class: 'tabs', role: 'tablist' });
      RANGES.forEach(function (r) {
        tabs.appendChild(el('button', { class: 'tab' + (r[0] === range ? ' active' : ''), type: 'button',
          role: 'tab', 'data-range': r[0], text: r[1], 'aria-selected': r[0] === range ? 'true' : 'false' }));
      });
      tabs.addEventListener('click', function (e) {
        const b = e.target.closest('[data-range]');
        if (!b || b.dataset.range === range) return;
        range = b.dataset.range;
        tabs.querySelectorAll('.tab').forEach(function (t) {
          const on = t === b;
          t.classList.toggle('active', on);
          t.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        renderChart(chartBox, c);
      });
      view.appendChild(el('div', { class: 'panel' }, [tabs, chartBox]));
      renderChart(chartBox, c);

      // Распределение по разделам
      view.appendChild(el('h2', { class: 'section-title', text: 'По разделам' }));
      const maxCount = Math.max(1, Math.max.apply(null, SECTIONS.map(function (s) { return c.counts[s.id]; })));
      const rows = el('div', { class: 'panel' });
      SECTIONS.forEach(function (s) {
        const fill = el('div', { class: 'hbar__fill' });
        fill.style.width = (c.counts[s.id] / maxCount * 100) + '%';
        rows.appendChild(el('div', { class: 'hbar' }, [
          el('span', { text: s.label }),
          el('div', { class: 'hbar__track' }, [fill]),
          el('span', { class: 'hbar__num', text: String(c.counts[s.id]) })
        ]));
      });
      view.appendChild(rows);
    }

    view.appendChild(el('p', { class: 'stats-note',
      text: 'Столбец показывает, сколько записей создано или в последний раз изменено в этот день. ' +
            'Всё считается на устройстве по существующим записям; удалённые не учитываются.' }));
  }

  /* ---------- Обновление ---------- */
  async function refresh() {
    if (location.hash !== '#statistics') return; // считаем только когда раздел открыт
    if (!VOID.auth || !VOID.auth.isUnlocked()) return;
    const id = ++runId;
    if (!cache) {
      view.textContent = '';
      view.appendChild(ui.emptyBlock('Загрузка…', ''));
    }
    try {
      const data = await collect();
      if (id !== runId || !VOID.auth.isUnlocked()) return;
      cache = compute(data);
      render(cache);
    } catch (err) {
      if (err && err.message === 'LOCKED') return;
      console.error('Statistics error:', err);
      VOID.toast('Не удалось посчитать статистику', 'error');
    }
  }

  function clear() {
    runId++;
    cache = null;
    range = '14';
    view.textContent = '';
  }

  window.addEventListener('hashchange', refresh);
  document.addEventListener('void:unlock', refresh);
  document.addEventListener('void:datachange', refresh);
  document.addEventListener('void:lock', clear);

  VOID.statistics = { refresh: refresh };
})();