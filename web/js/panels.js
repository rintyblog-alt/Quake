/* 各パネルの更新 (緊急地震速報・揺れを検出・津波・地震情報・履歴・凡例) */
(function (global) {
  'use strict';

  var U = global.Util;
  function el(id) { return document.getElementById(id); }

  var Panels = {};

  /* 規模・深さのバーの色 */
  function magnitudeColor(m) {
    if (m >= 8.0) return '#e838c8';
    if (m >= 7.0) return '#e03a2a';
    if (m >= 6.0) return '#f2941f';
    if (m >= 5.0) return '#d9e04a';
    if (m >= 4.0) return '#46c9a0';
    return '#3f8fd8';
  }
  function depthColor(d) {
    if (d < 20) return '#e03a2a';
    if (d < 50) return '#f2941f';
    if (d < 100) return '#d9e04a';
    if (d < 300) return '#46c9a0';
    return '#3f8fd8';
  }

  function setBadge(node, intensity) {
    var name = U.shindoClass(intensity);
    node.textContent = intensity <= -2.9 ? '-' : U.shindoShort(name);
    node.style.background = intensity <= -2.9 ? '#38465c' : U.shindoColor(name);
    node.style.color = intensity <= -2.9 ? '#fff' : U.shindoTextColor(name);
  }
  Panels.setBadge = setBadge;

  /* ---------------- 緊急地震速報 ---------------- */
  Panels.showEEW = function (report, originDate) {
    var panel = el('eew-panel');
    panel.classList.remove('hidden');
    var warn = report.kind === '警報';
    panel.classList.toggle('forecast', !warn);

    el('eew-grade').textContent = (report.isFinal ? '最終 ' : '') + report.kind +
                                  ' #' + U.pad(report.number);
    el('eew-region').textContent = report.region;
    el('eew-origin').textContent = originDate
      ? U.formatDate(originDate) + ' ' + U.formatClock(originDate) + ' 発生' : '';

    var box = el('eew-shindo-box');
    box.classList.toggle('forecast', !warn);
    el('eew-shindo-value').textContent = report.maxIntensity <= -2.9
      ? '-' : U.shindoShort(U.shindoClass(report.maxIntensity));

    el('eew-magnitude').textContent = Number(report.magnitude).toFixed(1);
    el('meter-mag-bar').style.background = magnitudeColor(report.magnitude);
    el('eew-depth').textContent = Math.round(report.depth) + 'km';
    el('meter-depth-bar').style.background = depthColor(report.depth);

    el('eew-message').innerHTML = warn
      ? '緊急地震速報（警報）発表<br>強い揺れに警戒してください'
      : '緊急地震速報（予報）発表<br>揺れに注意してください';
  };

  Panels.hideEEW = function () { el('eew-panel').classList.add('hidden'); };

  /* ---------------- 揺れを検出 ---------------- */
  Panels.showDetect = function (maxIntensity, areas) {
    el('detect-panel').classList.remove('hidden');
    setBadge(el('detect-value'), maxIntensity);
    var ul = el('detect-list');
    ul.innerHTML = '';
    if (!areas || !areas.length) {
      var li0 = document.createElement('li');
      li0.style.color = 'var(--text-faint)';
      li0.textContent = maxIntensity > -2.9 ? '揺れの広がりを監視中' : '観測中';
      ul.appendChild(li0);
      return;
    }
    areas.slice(0, 6).forEach(function (a) {
      var li = document.createElement('li');
      var badge = document.createElement('div');
      badge.className = 'shindo-badge sm';
      setBadge(badge, a.intensity);
      var name = document.createElement('span');
      name.className = 'area-name';
      name.textContent = a.name;
      li.appendChild(badge); li.appendChild(name);
      ul.appendChild(li);
    });
  };

  Panels.hideDetect = function () { el('detect-panel').classList.add('hidden'); };

  /* ---------------- 津波 ---------------- */
  var TSUNAMI_COLORS = ['#4fc3f7', '#f5d020', '#e0231c', '#e838c8'];

  Panels.showTsunami = function (forecast, originDate) {
    var panel = el('tsunami-panel');
    if (!forecast) { panel.classList.add('hidden'); return; }
    panel.className = 'grade-' + forecast.maxLevel;
    el('tsunami-head').textContent = forecast.maxGrade;
    el('tsunami-summary').textContent = '対象 ' + forecast.zones.length + ' 予報区';

    // 予想高さの区分ごとにまとめる
    var groups = [];
    var byClass = {};
    forecast.zones.forEach(function (z) {
      if (!byClass[z.heightClass]) {
        byClass[z.heightClass] = { cls: z.heightClass, level: z.level, zones: [] };
        groups.push(byClass[z.heightClass]);
      }
      byClass[z.heightClass].zones.push(z);
    });
    groups.sort(function (a, b) { return b.level - a.level || b.zones[0].height - a.zones[0].height; });

    var ul = el('tsunami-list');
    ul.innerHTML = '';
    groups.slice(0, 5).forEach(function (g) {
      var color = TSUNAMI_COLORS[Math.min(g.level, 3)];
      var head = document.createElement('li');
      head.className = 'tz-group';
      var hh = document.createElement('span');
      hh.className = 'tz-height';
      hh.style.background = color;
      hh.style.color = g.level === 1 ? '#1a1200' : '#fff';
      hh.textContent = g.cls;
      var gg = document.createElement('span');
      gg.className = 'tz-grade';
      gg.textContent = g.zones[0].grade;
      head.appendChild(hh); head.appendChild(gg);
      ul.appendChild(head);

      g.zones.slice(0, 4).forEach(function (z) {
        var li = document.createElement('li');
        li.className = 'tz-zone';
        li.style.borderLeftColor = color;
        var n = document.createElement('div');
        n.className = 'tz-name';
        n.textContent = z.name;
        var d = document.createElement('span');
        d.className = 'tz-detail';
        d.style.background = color;
        d.style.color = g.level === 1 ? '#1a1200' : '#fff';
        var at = originDate ? new Date(originDate.getTime() + z.arrival * 1000) : null;
        d.textContent = '到達 ' + (at ? U.pad(at.getHours()) + ':' + U.pad(at.getMinutes()) : '-') +
                        '  ' + z.height.toFixed(1) + 'm';
        li.appendChild(n); li.appendChild(d);
        ul.appendChild(li);
      });
    });
    panel.classList.remove('hidden');
  };

  Panels.hideTsunami = function () { el('tsunami-panel').classList.add('hidden'); };

  /* ---------------- 地震情報 (確定) ---------------- */
  Panels.showFinalInfo = function (info) {
    el('final-panel').classList.remove('hidden');
    var cls = U.shindoClass(info.maxIntensity);
    var bar = el('final-shindo');
    bar.textContent = '最大震度 ' + U.shindoShort(cls);
    bar.style.background = U.shindoColor(cls);
    bar.style.color = U.shindoTextColor(cls);

    el('final-when').textContent = info.time
      ? (info.time.getMonth() + 1) + '月' + info.time.getDate() + '日 ' +
        U.pad(info.time.getHours()) + '時' + U.pad(info.time.getMinutes()) + '分ごろ' : '';
    el('final-region').textContent = info.region;
    el('final-magnitude').textContent = Number(info.magnitude).toFixed(1);
    el('final-mag-bar').style.background = magnitudeColor(info.magnitude);
    el('final-depth').textContent = Math.round(info.depth) + 'km';
    el('final-depth-bar').style.background = depthColor(info.depth);

    var ul = el('final-areas');
    ul.innerHTML = '';
    (info.areas || []).slice(0, 8).forEach(function (a) {
      var li = document.createElement('li');
      var badge = document.createElement('div');
      badge.className = 'shindo-badge sm';
      setBadge(badge, a.intensity);
      var name = document.createElement('span');
      name.className = 'area-name';
      name.textContent = a.name;
      li.appendChild(badge); li.appendChild(name);
      ul.appendChild(li);
    });
  };

  Panels.hideFinalInfo = function () { el('final-panel').classList.add('hidden'); };

  /* ---------------- 直近の地震 / 履歴 ---------------- */
  Panels.renderRecent = function (list, activeIndex, onPlay) {
    var ul = el('recent-list');
    ul.innerHTML = '';
    list.slice(0, 5).forEach(function (q, i) {
      var li = document.createElement('li');
      if (i === activeIndex) li.classList.add('active');
      var badge = document.createElement('div');
      badge.className = 'shindo-badge sm';
      setBadge(badge, q.maxIntensity);
      var main = document.createElement('div');
      main.className = 'rl-main';
      var r = document.createElement('div');
      r.className = 'rl-region';
      r.textContent = q.region;
      var sub = document.createElement('div');
      sub.className = 'rl-sub';
      sub.textContent = U.formatMagnitude(q.magnitude) + ' / ' + Math.round(q.depth) + 'km' +
                        (q.time ? ' / ' + U.formatHM(q.time) : '');
      main.appendChild(r); main.appendChild(sub);
      var play = document.createElement('div');
      play.className = 'rl-play';
      play.textContent = '▶';
      li.appendChild(badge); li.appendChild(main); li.appendChild(play);
      li.addEventListener('click', function () { onPlay(i, q); });
      ul.appendChild(li);
    });
    if (!list.length) {
      var empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = 'まだ地震はありません';
      ul.appendChild(empty);
    }
  };

  Panels.renderHistory = function (list) {
    var ul = el('history-list');
    ul.innerHTML = '';
    list.slice(0, 15).forEach(function (q) {
      var cls = U.shindoClass(q.maxIntensity);
      var li = document.createElement('li');
      li.className = 'hist-row';
      li.style.background = U.shindoColor(cls);
      li.style.color = U.shindoTextColor(cls);

      var main = document.createElement('div');
      main.className = 'hist-main';
      var region = document.createElement('div');
      region.className = 'hist-region';
      region.textContent = q.region;
      var sub = document.createElement('div');
      sub.className = 'hist-sub';
      var when = document.createElement('span');
      when.textContent = q.time ? U.formatStamp(q.time) : '';
      var mag = document.createElement('b');
      mag.textContent = U.formatMagnitude(q.magnitude);
      sub.appendChild(when); sub.appendChild(mag);
      main.appendChild(region); main.appendChild(sub);

      var big = document.createElement('div');
      big.className = 'hist-shindo';
      big.textContent = U.shindoShort(cls);
      li.appendChild(main); li.appendChild(big);
      ul.appendChild(li);
    });
    if (!list.length) {
      var empty = document.createElement('li');
      empty.className = 'hist-empty';
      empty.textContent = '履歴はありません';
      ul.appendChild(empty);
    }
  };

  /* ---------------- 凡例 ---------------- */
  /* 参照している地震モニタと同じく、震度 5弱 から 1 までの 5 段で示す */
  var LEGEND_LEVELS = ['5弱', '4', '3', '2', '1'];

  Panels.drawLegend = function () {
    var c = el('legend-bar');
    var ctx = c.getContext('2d');
    var band = c.height / LEGEND_LEVELS.length;
    for (var i = 0; i < LEGEND_LEVELS.length; i++) {
      ctx.fillStyle = U.shindoColor(LEGEND_LEVELS[i]);
      ctx.fillRect(0, i * band, c.width, band + 0.5);
    }
    var ul = el('legend-list');
    ul.innerHTML = '';
    LEGEND_LEVELS.forEach(function (name) {
      var li = document.createElement('li');
      li.textContent = '震度' + name;
      ul.appendChild(li);
    });
  };

  Panels.setLegendStyle = function (style) {
    el('style-number').classList.toggle('active', style !== 'color');
    el('style-color').classList.toggle('active', style === 'color');
  };

  /* ---------------- トースト ---------------- */
  var toastTimer = null;
  Panels.toast = function (msg, ms) {
    var t = el('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add('hidden'); }, ms || 2600);
  };

  global.Panels = Panels;
})(window);
