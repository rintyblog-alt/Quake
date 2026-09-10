/* 各パネルの更新 (緊急地震速報・揺れを検出・津波・地震情報・履歴・凡例) */
(function (global) {
  'use strict';

  var U = global.Util;
  function el(id) { return document.getElementById(id); }

  var Panels = {};

  /* 深さの欄。「ごく浅い」のときは数字より字数が多いので少し小さくする。 */
  function setDepth(id, km) {
    var box = el(id), text = U.formatDepth(km);
    box.textContent = text;
    box.classList.toggle('as-text', /[^0-9km]/.test(text));
  }

  /* 規模・深さのバーの色 (震度と同じ配色をそのまま使う) */
  function magnitudeColor(m) {
    if (m >= 8.0) return U.shindoColor('6強');
    if (m >= 7.0) return U.shindoColor('5弱');
    if (m >= 6.0) return U.shindoColor('4');
    if (m >= 5.0) return U.shindoColor('3');
    if (m >= 4.0) return U.shindoColor('2');
    return U.shindoColor('1');
  }
  function depthColor(d) {
    if (d < 20) return U.shindoColor('5弱');
    if (d < 50) return U.shindoColor('4');
    if (d < 100) return U.shindoColor('3');
    if (d < 300) return U.shindoColor('2');
    return U.shindoColor('1');
  }

  /* 震度の表記。5弱・5強などの記号は肩に小さく付ける (5⁻ 5⁺ 6⁻ 6⁺)。 */
  function shindoHTML(name) {
    var t = U.shindoShort(name);
    return t.length > 1 ? t.charAt(0) + '<i>' + t.charAt(1) + '</i>' : t;
  }
  Panels.shindoHTML = shindoHTML;

  function setBadge(node, intensity) {
    var name = U.shindoClass(intensity);
    node.innerHTML = intensity <= -2.9 ? '-' : shindoHTML(name);
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

    el('eew-grade').textContent = report.kind + (report.isFinal ? ' 最終' : '');
    el('eew-region').textContent = report.region;
    el('eew-origin').textContent = originDate
      ? U.formatDate(originDate) + ' ' + U.formatClock(originDate) + ' 発生' : '';

    // 推定最大震度の帯は、震度の配色をそのまま使う
    var box = el('eew-shindo-box');
    box.classList.toggle('forecast', !warn);
    var known = report.maxIntensity > -2.9;
    var cls = U.shindoClass(report.maxIntensity);
    box.style.background = known ? U.shindoColor(cls) : '#38465c';
    box.style.color = known ? U.shindoTextColor(cls) : '#fff';
    el('eew-shindo-value').innerHTML = known ? shindoHTML(cls) : '-';

    el('eew-magnitude').textContent = Number(report.magnitude).toFixed(1);
    el('meter-mag-bar').style.background = magnitudeColor(report.magnitude);
    setDepth('eew-depth', report.depth);
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

  /* ---------------- エリアメール (緊急速報メール) ---------------- */
  Panels.showAreaMail = function (place) {
    el('am-place').textContent = place || '〇〇';
    el('area-mail').classList.remove('hidden');
  };

  Panels.hideAreaMail = function () {
    var box = el('area-mail');
    if (box) box.classList.add('hidden');
  };

  /* ---------------- 地震情報 (確定) ---------------- */
  /* 地震情報の 3 段階 (気象庁の発表順) */
  var INFO_KINDS = ['震度速報', '震源に関する情報', '震源・震度に関する情報'];

  Panels.showFinalInfo = function (info) {
    el('final-panel').classList.remove('hidden');
    // 震度速報の段階では震源がまだ決まっていない
    var stage = info.stage || 3;
    var hasHypo = stage >= 2;
    el('final-kind').textContent = INFO_KINDS[stage - 1];

    var cls = U.shindoClass(info.maxIntensity);
    var bar = el('final-shindo');
    bar.innerHTML = '最大震度 ' + shindoHTML(cls);
    bar.style.background = U.shindoColor(cls);
    bar.style.color = U.shindoTextColor(cls);

    el('final-when').textContent = info.time
      ? (info.time.getMonth() + 1) + '月' + info.time.getDate() + '日 ' +
        U.pad(info.time.getHours()) + '時' + U.pad(info.time.getMinutes()) + '分ごろ' : '';
    el('final-region').textContent = hasHypo ? info.region : '震源を調査中';
    el('final-magnitude').textContent = hasHypo ? Number(info.magnitude).toFixed(1) : '--';
    el('final-mag-bar').style.background =
      hasHypo ? magnitudeColor(info.magnitude) : 'var(--panel-3)';
    if (hasHypo) setDepth('final-depth', info.depth);
    else { el('final-depth').textContent = '--'; el('final-depth').classList.remove('as-text'); }
    el('final-depth-bar').style.background =
      hasHypo ? depthColor(info.depth) : 'var(--panel-3)';

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
      big.innerHTML = shindoHTML(cls);
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
  var LEGEND_LEVELS = ['7', '6強', '6弱', '5強', '5弱', '4', '3', '2', '1'];
  var TSUNAMI_LEVELS = [
    ['大津波警報', '#e838c8'], ['津波警報', '#e0231c'],
    ['津波注意報', '#f5d020'], ['津波予報', '#4fc3f7']
  ];

  Panels.drawLegend = function (style) {
    var c = el('legend-bar');
    var ctx = c.getContext('2d');
    var ul = el('legend-list');
    ul.innerHTML = '';
    ctx.clearRect(0, 0, c.width, c.height);

    if (style === 'coast') {
      // 津波の沿岸線だけを出すモード。帯は発表の段の色をそのまま並べる。
      var band0 = c.height / TSUNAMI_LEVELS.length;
      for (var t = 0; t < TSUNAMI_LEVELS.length; t++) {
        ctx.fillStyle = TSUNAMI_LEVELS[t][1];
        ctx.fillRect(0, t * band0, c.width, band0 + 0.5);
      }
      TSUNAMI_LEVELS.forEach(function (lv) {
        var li = document.createElement('li');
        li.textContent = lv[0];
        ul.appendChild(li);
      });
      fitLabels(ul, TSUNAMI_LEVELS.length);
      return;
    }

    if (style === 'color') {
      // PGA は対数目盛なので、帯は連続、目盛だけ 10 の冪で刻む
      var ticks = U.pgaTicks;
      var lo = Math.log10(ticks[0]), hi = Math.log10(ticks[ticks.length - 1]);
      for (var y = 0; y < c.height; y++) {
        var g = Math.pow(10, hi - (hi - lo) * (y + 0.5) / c.height);
        ctx.fillStyle = U.pgaCSS(g);
        ctx.fillRect(0, y, c.width, 1);
      }
      var step = Math.max(1, Math.round(ticks.length / 6));
      var count = 0;
      for (var k = ticks.length - 1; k >= 0; k -= step) {
        var li = document.createElement('li');
        li.textContent = ticks[k] + ' gal';
        ul.appendChild(li);
        count++;
      }
      fitLabels(ul, count);
      return;
    }

    var band = c.height / LEGEND_LEVELS.length;
    for (var i = 0; i < LEGEND_LEVELS.length; i++) {
      ctx.fillStyle = U.shindoColor(LEGEND_LEVELS[i]);
      ctx.fillRect(0, i * band, c.width, band + 0.5);
    }
    LEGEND_LEVELS.forEach(function (name) {
      var li = document.createElement('li');
      li.textContent = '震度' + name;
      ul.appendChild(li);
    });
    fitLabels(ul, LEGEND_LEVELS.length);
  };

  /* 目盛の数が変わっても帯の高さに収まるようにする */
  function fitLabels(ul, count) {
    var h = ul.getBoundingClientRect().height || 130;
    var line = Math.floor(h / Math.max(count, 1));
    // 段が増えると重なるので、行の高さに合わせて字も縮める
    var size = Math.max(8, Math.min(12, Math.floor(line * 0.82)));
    for (var i = 0; i < ul.children.length; i++) {
      ul.children[i].style.lineHeight = line + 'px';
      ul.children[i].style.fontSize = size + 'px';
    }
  }

  Panels.setLegendStyle = function (style) {
    el('style-number').classList.toggle('active', style === 'number');
    el('style-color').classList.toggle('active', style === 'color');
    el('style-coast').classList.toggle('active', style === 'coast');
    el('legend-title').textContent =
      style === 'color' ? '地表最大加速度' : (style === 'coast' ? '津波の沿岸線' : '地図の色');
    Panels.drawLegend(style);
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
