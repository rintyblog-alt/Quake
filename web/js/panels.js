/* 各種パネルの更新 (緊急地震速報・地震情報・履歴・津波・凡例) */
(function (global) {
  'use strict';

  var U = global.Util;
  function el(id) { return document.getElementById(id); }

  var Panels = {};

  /* ---------------- 震度バッジ ---------------- */
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
    panel.classList.toggle('forecast', report.kind !== '警報');

    el('eew-grade').textContent = report.kind;
    el('eew-number').textContent = report.isFinal ? '最終報 #' + report.number : '#' + report.number;
    el('eew-region').textContent = report.region;
    el('eew-origin').textContent = originDate
      ? U.formatDate(originDate) + ' ' + U.formatClock(originDate) + ' 発生' : '';

    setBadge(el('eew-shindo-value'), report.maxIntensity);

    // 長周期地震動階級は予想震度から概算する
    var lg = U.lgClassFromPgv(U.pgvFromIntensity ? U.pgvFromIntensity(report.maxIntensity)
                                                 : Math.pow(10, (report.maxIntensity - 2.68) / 1.72));
    var lgNode = el('eew-lg-value');
    lgNode.textContent = lg > 0 ? String(lg) : '-';
    lgNode.style.background = ['#38465c', '#3fbf6f', '#f5a623', '#f06a1e', '#c01818'][lg];
    lgNode.style.color = lg === 1 || lg === 2 ? '#0d2415' : '#fff';

    el('eew-magnitude').textContent = Number(report.magnitude).toFixed(1);
    el('eew-depth').textContent = Math.round(report.depth) + 'km';

    el('eew-message').innerHTML = report.kind === '警報'
      ? '緊急地震速報（警報）発表<br>強い揺れに警戒してください'
      : '緊急地震速報（予報）発表<br>揺れに注意してください';

    var areas = el('eew-warning-areas');
    areas.innerHTML = '';
    if (report.warningRegions && report.warningRegions.length) {
      report.warningRegions.forEach(function (name) {
        var s2 = document.createElement('span');
        s2.textContent = name;
        areas.appendChild(s2);
      });
    }
  };

  /* 現在のリアルタイム震度の最大値 */
  Panels.setRealtimeMax = function (intensity) {
    setBadge(el('eew-rt-value'), intensity);
  };

  Panels.hideEEW = function () {
    el('eew-panel').classList.add('hidden');
    el('eew-countdown').textContent = '';
  };

  Panels.setCountdown = function (text) { el('eew-countdown').textContent = text || ''; };

  /* ---------------- 地震情報 (現在) ---------------- */
  Panels.showQuakeInfo = function (info) {
    setBadge(el('cur-shindo'), info.maxIntensity);
    el('cur-region').textContent = info.region;
    el('cur-time').textContent = info.time ? U.formatHM(info.time) + ' 頃発生' : '';
    el('cur-maxshindo').textContent = '震度 ' + U.shindoClass(info.maxIntensity);
    el('cur-region2').textContent = info.region;
    el('cur-magnitude').textContent = U.formatMagnitude(info.magnitude);
    el('cur-depth').textContent = U.formatDepth(info.depth);
  };

  /* ---------------- 直近 5 件 (再生可能) ---------------- */
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
      sub.textContent = U.formatMagnitude(q.magnitude) + ' / ' + U.formatDepth(q.depth) +
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
      empty.style.color = 'var(--text-faint)';
      empty.style.gridTemplateColumns = '1fr';
      empty.textContent = 'まだ地震はありません';
      ul.appendChild(empty);
    }
  };

  /* ---------------- 履歴 15 件 ---------------- */
  /* 行全体を最大震度の色で塗り、右端に大きな震度の数字を置く */
  Panels.renderHistory = function (list) {
    var ul = el('history-list');
    ul.innerHTML = '';
    list.slice(0, 15).forEach(function (q) {
      var cls = U.shindoClass(q.maxIntensity);
      var color = U.shindoColor(cls);
      var fg = U.shindoTextColor(cls);

      var li = document.createElement('li');
      li.className = 'hist-row';
      li.style.background = color;
      li.style.color = fg;

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
      big.style.color = fg;

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

  /* ---------------- 地震情報 (確定) ---------------- */
  /* 揺れが収まったあとに出す、観測された震度の確定表示 */
  Panels.showFinalInfo = function (info) {
    var panel = el('final-panel');
    panel.classList.remove('hidden');
    var cls = U.shindoClass(info.maxIntensity);

    var bar = el('final-shindo');
    bar.textContent = '最大震度 ' + U.shindoShort(cls);
    bar.style.background = U.shindoColor(cls);
    bar.style.color = U.shindoTextColor(cls);

    el('final-when').textContent = info.time
      ? (info.time.getMonth() + 1) + '月' + info.time.getDate() + '日 ' +
        U.pad(info.time.getHours()) + '時' + U.pad(info.time.getMinutes()) + '分ごろ'
      : '';
    el('final-region').textContent = info.region;
    el('final-magnitude').textContent = Number(info.magnitude).toFixed(1);
    el('final-depth').textContent = Math.round(info.depth) + 'km';

    var banner = el('tsunami-banner');
    banner.classList.remove('hidden');
    if (info.tsunami) {
      banner.textContent = 'この地震により' + info.tsunami.maxGrade + 'が発表されています';
      banner.className = 'tsunami-banner alert';
    } else {
      banner.textContent = 'この地震による津波の心配はありません';
      banner.className = 'tsunami-banner';
    }
  };

  Panels.hideFinalInfo = function () {
    el('final-panel').classList.add('hidden');
    el('tsunami-banner').classList.add('hidden');
  };

  /* ---------------- 津波 ---------------- */
  Panels.showTsunami = function (forecast) {
    var panel = el('tsunami-panel');
    if (!forecast) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
    panel.className = 'panel grade-' + forecast.maxLevel;

    el('tsunami-head').textContent = forecast.maxGrade;
    var ul = el('tsunami-list');
    ul.innerHTML = '';
    forecast.zones.slice(0, 14).forEach(function (z) {
      var li = document.createElement('li');
      li.className = 'tz-' + z.level;
      var n = document.createElement('span'); n.className = 'tz-name'; n.textContent = z.name;
      var h = document.createElement('span'); h.className = 'tz-h'; h.textContent = z.heightClass;
      var t = document.createElement('span'); t.className = 'tz-t';
      t.textContent = '約' + Math.round(z.arrival / 60) + '分';
      li.appendChild(n); li.appendChild(h); li.appendChild(t);
      ul.appendChild(li);
    });
  };

  Panels.hideTsunami = function () { el('tsunami-panel').classList.add('hidden'); };

  /* ---------------- 地図の色 (凡例) ---------------- */
  Panels.drawLegend = function () {
    var ul = el('legend-list');
    ul.innerHTML = '';
    // 大きい震度を上に並べる
    U.shindoOrder.slice().reverse().forEach(function (name) {
      var li = document.createElement('li');
      var sw = document.createElement('span');
      sw.className = 'legend-sw';
      sw.style.background = U.shindoColor(name);
      sw.style.color = U.shindoTextColor(name);
      sw.textContent = U.shindoShort(name);
      var label = document.createElement('span');
      label.className = 'legend-name';
      label.textContent = '震度' + name;
      li.appendChild(sw); li.appendChild(label);
      ul.appendChild(li);
    });
  };

  /* 観測点の表示スタイルに合わせて凡例を切り替える */
  Panels.setLegendStyle = function (style) {
    var list = el('legend-list'), bar = el('legend-bar'), ticks = el('legend-ticks');
    var isColor = style === 'color';
    list.classList.toggle('hidden', isColor);
    bar.classList.toggle('hidden', !isColor);
    ticks.classList.toggle('hidden', !isColor);
    el('style-number').classList.toggle('active', !isColor);
    el('style-color').classList.toggle('active', isColor);
    if (isColor) Panels.drawLegendBar();
  };

  /* リアルタイム震度の連続配色バー */
  Panels.drawLegendBar = function () {
    var c = el('legend-bar');
    var ctx = c.getContext('2d');
    var w = c.width, h = c.height;
    var img = ctx.createImageData(w, h);
    for (var x = 0; x < w; x++) {
      var v = -1 + (x / (w - 1)) * 8;
      var rgb = U.realtimeRGB(v);
      for (var y = 0; y < h; y++) {
        var o = (y * w + x) * 4;
        img.data[o] = rgb[0]; img.data[o + 1] = rgb[1];
        img.data[o + 2] = rgb[2]; img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
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
