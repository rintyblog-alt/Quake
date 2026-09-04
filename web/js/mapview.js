/* 日本地図と観測点・波面の描画
 *
 * 背景 (陸域ポリゴン・県境) は表示範囲が変わったときだけオフスクリーンに
 * 描き直し、毎フレームはそれを転送したうえで観測点・波面・震源などの
 * 動的な要素だけを描く。
 */
(function (global) {
  'use strict';

  /* 明るい配色: 水色の海とベージュの陸 */
  var LAND_FILL = '#ddcfa4';
  var LAND_FILL_HI = '#e9dcb6';
  var PREF_LINE = '#b6a67c';
  var COAST_LINE = '#8d7f5c';
  var SEA_FILL = '#9ecfe6';
  var SEA_FILL_DEEP = '#7fb9d8';

  function MapView(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.min(global.devicePixelRatio || 1, 2);
    this.proj = new global.Projection(1, 1);

    this.geo = null;
    this.stations = null;
    this.tsunamiZones = null;

    this.base = document.createElement('canvas');
    this.baseCtx = this.base.getContext('2d');
    this.baseKey = '';

    this.stationRadius = 2.3;
    this.showStations = true;
    this.stationStyle = 'number';   // 'number' = 震度の数字入りの円 / 'color' = 色のみの円
    this.resize();
  }

  MapView.prototype.resize = function () {
    var rect = this.canvas.getBoundingClientRect();
    var w = Math.max(1, Math.round(rect.width));
    var h = Math.max(1, Math.round(rect.height));
    this.cssWidth = w; this.cssHeight = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.base.width = this.canvas.width;
    this.base.height = this.canvas.height;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.baseCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.proj.resize(w, h);
    this.baseKey = '';
  };

  MapView.prototype.setGeo = function (geojson) {
    this.geo = geojson;
    this.baseKey = '';
    this.prefCentroid = {};
    this.prefFeature = {};
    for (var f = 0; f < geojson.features.length; f++) {
      var feat = geojson.features[f];
      var id = feat.properties.id;
      this.prefFeature[id] = feat;
      // 最大の島を代表とし、その重心を震度バッジの位置にする
      var best = null, bestArea = -1;
      var polys = feat.geometry.coordinates;
      for (var q = 0; q < polys.length; q++) {
        var ring = polys[q][0];
        var a = Math.abs(ringArea(ring));
        if (a > bestArea) { bestArea = a; best = ring; }
      }
      if (best) this.prefCentroid[id] = ringCentroid(best);
    }
  };

  function ringArea(ring) {
    var a = 0;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    }
    return a / 2;
  }
  function ringCentroid(ring) {
    var a = 0, cx = 0, cy = 0;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      a += f; cx += (ring[j][0] + ring[i][0]) * f; cy += (ring[j][1] + ring[i][1]) * f;
    }
    if (Math.abs(a) < 1e-12) return [ring[0][1], ring[0][0]];
    a *= 3;
    return [cy / a, cx / a];   // [lat, lon]
  }
  MapView.prototype.setStations = function (s) { this.stations = s; };
  MapView.prototype.setTsunamiZones = function (z) { this.tsunamiZones = z; };

  /* ---------------- 背景レイヤ ---------------- */
  MapView.prototype.viewKey = function () {
    var p = this.proj;
    return [p.centerLat.toFixed(5), p.centerLon.toFixed(5), p.zoom.toFixed(5),
            this.cssWidth, this.cssHeight].join('|');
  };

  MapView.prototype.drawBase = function () {
    var key = this.viewKey();
    if (key === this.baseKey || !this.geo) return;
    this.baseKey = key;

    var ctx = this.baseCtx, p = this.proj;
    ctx.save();
    var sea = ctx.createLinearGradient(0, 0, 0, this.cssHeight);
    sea.addColorStop(0, SEA_FILL);
    sea.addColorStop(1, SEA_FILL_DEEP);
    ctx.fillStyle = sea;
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);

    // 表示範囲より少し広い矩形の外は描かない
    var tl = p.unproject(-80, -80);
    var br = p.unproject(this.cssWidth + 80, this.cssHeight + 80);
    var latMin = Math.min(tl[0], br[0]), latMax = Math.max(tl[0], br[0]);
    var lonMin = Math.min(tl[1], br[1]), lonMax = Math.max(tl[1], br[1]);

    var fill = new Path2D();
    var borders = new Path2D();
    var feats = this.geo.features;

    for (var f = 0; f < feats.length; f++) {
      var polys = feats[f].geometry.coordinates;
      for (var q = 0; q < polys.length; q++) {
        var rings = polys[q];
        for (var r = 0; r < rings.length; r++) {
          var ring = rings[r];
          // 簡易バウンディングチェック
          var inView = false;
          for (var k = 0; k < ring.length; k += 8) {
            var c = ring[k];
            if (c[0] >= lonMin && c[0] <= lonMax && c[1] >= latMin && c[1] <= latMax) {
              inView = true; break;
            }
          }
          if (!inView) continue;

          var started = false;
          for (var i = 0; i < ring.length; i++) {
            var pt = p.project(ring[i][1], ring[i][0]);
            if (!started) { fill.moveTo(pt[0], pt[1]); borders.moveTo(pt[0], pt[1]); started = true; }
            else { fill.lineTo(pt[0], pt[1]); borders.lineTo(pt[0], pt[1]); }
          }
          if (started) { fill.closePath(); borders.closePath(); }
        }
      }
    }

    // 陸の輪郭に薄い影を落として立体感を出す
    ctx.save();
    ctx.shadowColor = 'rgba(40, 60, 80, 0.35)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 2;
    var grad = ctx.createLinearGradient(0, 0, 0, this.cssHeight);
    grad.addColorStop(0, LAND_FILL_HI);
    grad.addColorStop(1, LAND_FILL);
    ctx.fillStyle = grad;
    ctx.fill(fill, 'evenodd');
    ctx.restore();

    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.min(1.0, 0.4 + this.proj.zoom * 0.07);
    ctx.strokeStyle = PREF_LINE;
    ctx.stroke(borders);

    // 海岸線を少し強調する
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = Math.min(1.5, 0.7 + this.proj.zoom * 0.06);
    ctx.strokeStyle = COAST_LINE;
    ctx.stroke(borders);
    ctx.globalAlpha = 1;
    ctx.restore();
  };

  /* ---------------- 観測点 ---------------- */
  /* 震度階級の数字を入れた円で描く。
   * 震度 0 未満 (揺れを検出していない点) は小さな点にとどめる。 */
  MapView.prototype.drawStations = function (values) {
    if (!this.stations || !this.showStations) return;
    if (this.stationStyle === 'color') return this.drawStationsColor(values);
    var ctx = this.ctx, p = this.proj, U = global.Util;
    var lat = this.stations.lat, lon = this.stations.lon;
    var n = lat.length;

    var radius = global.Util.clamp(4.6 * Math.pow(p.zoom, 0.42), 4.0, 17.0);
    var showNumber = radius >= 6.5;
    var margin = 24;

    // 弱い点はまとめて小さな点で描く
    var faint = new Path2D();
    var i, k;

    // 円が重ならないよう、画面を格子に切って各セルの最大震度だけ残す
    var cell = radius * 2.25;
    var cols = Math.ceil((this.cssWidth + margin * 2) / cell) + 1;
    var best = {};            // セル番号 -> [x, y, 震度]

    for (i = 0; i < n; i++) {
      var v = values ? values[i] : -3;
      var pt = p.project(lat[i], lon[i]);
      if (pt[0] < -margin || pt[0] > this.cssWidth + margin ||
          pt[1] < -margin || pt[1] > this.cssHeight + margin) continue;

      if (v < -0.5) {
        faint.moveTo(pt[0] + 1.5, pt[1]);
        faint.arc(pt[0], pt[1], 1.5, 0, Math.PI * 2);
        continue;
      }
      var key = Math.floor((pt[1] + margin) / cell) * cols + Math.floor((pt[0] + margin) / cell);
      var cur = best[key];
      if (!cur || v > cur[2]) best[key] = [pt[0], pt[1], v];
    }

    var groups = {};          // 階級 -> [[x, y], ...]
    for (var key2 in best) {
      var e = best[key2];
      var cls0 = U.shindoClass(e[2]);
      (groups[cls0] || (groups[cls0] = [])).push([e[0], e[1]]);
    }

    ctx.save();
    ctx.fillStyle = 'rgba(70, 92, 112, 0.5)';
    ctx.fill(faint);

    // 震度の小さい順に描き、大きい揺れを前面に出す
    var order = U.shindoOrder;
    ctx.lineWidth = Math.max(1, radius * 0.16);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 ' + Math.round(radius * 1.18) + 'px "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif';

    for (k = 0; k < order.length; k++) {
      var list = groups[order[k]];
      if (!list) continue;
      var fill = U.shindoColor(order[k]);
      var path = new Path2D();
      for (i = 0; i < list.length; i++) {
        path.moveTo(list[i][0] + radius, list[i][1]);
        path.arc(list[i][0], list[i][1], radius, 0, Math.PI * 2);
      }
      ctx.fillStyle = fill;
      ctx.strokeStyle = 'rgba(255,255,255,0.92)';
      ctx.fill(path);
      ctx.stroke(path);

      if (showNumber) {
        ctx.fillStyle = U.shindoTextColor(order[k]);
        var label = U.shindoShort(order[k]);
        for (i = 0; i < list.length; i++) {
          ctx.fillText(label, list[i][0], list[i][1] + radius * 0.04);
        }
      }
    }
    ctx.restore();
  };

  /* 色だけの円で描く (リアルタイム震度の連続配色。数字は出さない) */
  MapView.prototype.drawStationsColor = function (values) {
    var ctx = this.ctx, p = this.proj, U = global.Util;
    var lat = this.stations.lat, lon = this.stations.lon;
    var n = lat.length;
    var radius = U.clamp(2.4 * Math.pow(p.zoom, 0.35), 1.8, 6.0);
    var margin = 20;

    var BUCKETS = 48, lo = -3.0, hi = 7.0;
    var paths = new Array(BUCKETS);
    var i, b;

    for (i = 0; i < n; i++) {
      var v = values ? values[i] : -3;
      var pt = p.project(lat[i], lon[i]);
      if (pt[0] < -margin || pt[0] > this.cssWidth + margin ||
          pt[1] < -margin || pt[1] > this.cssHeight + margin) continue;
      b = Math.round((U.clamp(v, lo, hi) - lo) / (hi - lo) * (BUCKETS - 1));
      if (!paths[b]) paths[b] = new Path2D();
      paths[b].moveTo(pt[0] + radius, pt[1]);
      paths[b].arc(pt[0], pt[1], radius, 0, Math.PI * 2);
    }

    ctx.save();
    for (b = 0; b < BUCKETS; b++) {
      if (!paths[b]) continue;
      var val = lo + (hi - lo) * b / (BUCKETS - 1);
      ctx.fillStyle = U.realtimeCSS(val);
      if (val >= 2.5) {
        ctx.shadowColor = ctx.fillStyle;
        ctx.shadowBlur = 3 + (val - 2.5) * 3;
      } else {
        ctx.shadowBlur = 0;
      }
      ctx.fill(paths[b]);
    }
    ctx.restore();
  };

  /* ---------------- 確定震度 (地域の塗り分け) ---------------- */
  /* prefIntensity: 都道府県コード -> 最大計測震度 */
  MapView.prototype.drawObservedAreas = function (prefIntensity) {
    if (!this.geo || !prefIntensity) return;
    var ctx = this.ctx, p = this.proj, U = global.Util;

    for (var code in prefIntensity) {
      var v = prefIntensity[code];
      if (!(v >= 0.5)) continue;               // 震度 1 未満は塗らない
      var feat = this.prefFeature[code];
      if (!feat) continue;

      var path = new Path2D();
      var polys = feat.geometry.coordinates;
      for (var q = 0; q < polys.length; q++) {
        for (var r = 0; r < polys[q].length; r++) {
          var ring = polys[q][r];
          for (var i = 0; i < ring.length; i++) {
            var pt = p.project(ring[i][1], ring[i][0]);
            if (i === 0) path.moveTo(pt[0], pt[1]); else path.lineTo(pt[0], pt[1]);
          }
          path.closePath();
        }
      }
      ctx.save();
      ctx.fillStyle = U.shindoColor(U.shindoClass(v));
      ctx.globalAlpha = 0.72;
      ctx.fill(path, 'evenodd');
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(255,255,255,.85)';
      ctx.lineWidth = 1.1;
      ctx.stroke(path);
      ctx.restore();
    }
  };

  /* 確定表示のときの観測点 (地域の塗り分けを邪魔しない小さな点) */
  MapView.prototype.drawStationDots = function (values) {
    if (!this.stations || !this.showStations) return;
    var ctx = this.ctx, p = this.proj, U = global.Util;
    var lat = this.stations.lat, lon = this.stations.lon;
    var n = lat.length, margin = 16;
    var r = U.clamp(1.6 * Math.pow(p.zoom, 0.3), 1.3, 3.4);

    var groups = {};
    for (var i = 0; i < n; i++) {
      var v = values ? values[i] : -3;
      if (!(v >= 0.5)) continue;
      var pt = p.project(lat[i], lon[i]);
      if (pt[0] < -margin || pt[0] > this.cssWidth + margin ||
          pt[1] < -margin || pt[1] > this.cssHeight + margin) continue;
      var cls = U.shindoClass(v);
      var path = groups[cls] || (groups[cls] = new Path2D());
      path.moveTo(pt[0] + r, pt[1]);
      path.arc(pt[0], pt[1], r, 0, Math.PI * 2);
    }
    ctx.save();
    ctx.globalAlpha = 0.9;
    for (var cls2 in groups) {
      ctx.fillStyle = U.shindoColor(cls2);
      ctx.fill(groups[cls2]);
      ctx.lineWidth = 0.7;
      ctx.strokeStyle = 'rgba(255,255,255,.75)';
      ctx.stroke(groups[cls2]);
    }
    ctx.restore();
  };

  /* 地域ごとの震度バッジ (角丸の四角に震度の数字) */
  MapView.prototype.drawAreaBadges = function (prefIntensity) {
    if (!prefIntensity) return;
    var ctx = this.ctx, p = this.proj, U = global.Util;
    var placed = [];

    // 震度の大きい地域から置き、重なるものは省く
    var entries = [];
    for (var code in prefIntensity) {
      if (prefIntensity[code] >= 0.5 && this.prefCentroid[code]) {
        entries.push([code, prefIntensity[code]]);
      }
    }
    entries.sort(function (a, b) { return b[1] - a[1]; });

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (var k = 0; k < entries.length; k++) {
      var c = this.prefCentroid[entries[k][0]];
      var pt = p.project(c[0], c[1]);
      if (pt[0] < 10 || pt[0] > this.cssWidth - 10 || pt[1] < 10 || pt[1] > this.cssHeight - 10) continue;

      var w = 30, h = 26;
      var clash = false;
      for (var m = 0; m < placed.length; m++) {
        if (Math.abs(placed[m][0] - pt[0]) < w * 1.15 && Math.abs(placed[m][1] - pt[1]) < h * 1.15) {
          clash = true; break;
        }
      }
      if (clash) continue;
      placed.push(pt);

      var cls = U.shindoClass(entries[k][1]);
      roundRect(ctx, pt[0] - w / 2, pt[1] - h / 2, w, h, 5);
      ctx.fillStyle = U.shindoColor(cls);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255,255,255,.95)';
      ctx.stroke();

      ctx.fillStyle = U.shindoTextColor(cls);
      ctx.font = '800 16px var(--mono), "SF Mono", monospace';
      ctx.fillText(U.shindoShort(cls), pt[0], pt[1] + 1);
    }
    ctx.restore();
  };

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ---------------- 波面 ---------------- */
  MapView.prototype.drawWavefronts = function (lat, lon, pRadiusKm, sRadiusKm) {
    var ctx = this.ctx, p = this.proj;
    var c = p.project(lat, lon);

    function ring(radiusKm, stroke, fill, width, dash) {
      if (!(radiusKm > 0)) return;
      var r = p.kmToPixels(radiusKm);
      if (r < 1 || r > 20000) return;
      ctx.save();
      ctx.beginPath();
      ctx.arc(c[0], c[1], r, 0, Math.PI * 2);
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      ctx.setLineDash(dash || []);
      ctx.strokeStyle = stroke;
      ctx.lineWidth = width;
      ctx.stroke();
      ctx.restore();
    }

    ring(sRadiusKm, 'rgba(232, 74, 26, 0.95)', 'rgba(240, 96, 40, 0.13)', 2.6);
    ring(pRadiusKm, 'rgba(28, 96, 200, 0.9)', null, 1.8, [8, 5]);
  };

  /* ---------------- 震源 ---------------- */
  MapView.prototype.drawEpicenter = function (lat, lon, pulse) {
    var ctx = this.ctx, p = this.proj;
    var c = p.project(lat, lon);
    var s = 11;

    if (pulse > 0) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, 0.85 - pulse);
      ctx.strokeStyle = '#e01a0c';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(c[0], c[1], s + pulse * 26, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(c[0] - s, c[1] - s); ctx.lineTo(c[0] + s, c[1] + s);
    ctx.moveTo(c[0] + s, c[1] - s); ctx.lineTo(c[0] - s, c[1] + s);
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = 6.5;
    ctx.stroke();
    ctx.strokeStyle = '#e01a0c';
    ctx.lineWidth = 3.4;
    ctx.stroke();
    ctx.restore();
  };

  /* 断層面の地表投影 */
  MapView.prototype.drawRupture = function (rupture, progressSec) {
    if (!rupture || !rupture.lat) return;
    var ctx = this.ctx, p = this.proj;
    ctx.save();
    for (var i = 0; i < rupture.lat.length; i++) {
      if (rupture.delay[i] > progressSec) continue;
      var pt = p.project(rupture.lat[i], rupture.lon[i]);
      var age = progressSec - rupture.delay[i];
      var alpha = Math.max(0.12, 0.55 - age * 0.05);
      ctx.fillStyle = 'rgba(210, 60, 10, ' + alpha.toFixed(3) + ')';
      ctx.fillRect(pt[0] - 2, pt[1] - 2, 4, 4);
    }
    ctx.restore();
  };

  /* ---------------- 津波 ---------------- */
  var TSUNAMI_COLORS = ['#5a7a92', '#e8a317', '#e0341c', '#c400a8'];

  MapView.prototype.drawTsunami = function (forecast, elapsed) {
    if (!forecast || !this.tsunamiZones) return;
    var ctx = this.ctx, p = this.proj;
    var byCode = {};
    for (var i = 0; i < forecast.zones.length; i++) byCode[forecast.zones[i].code] = forecast.zones[i];

    var blink = 0.55 + 0.45 * Math.sin(elapsed * 3.0);
    ctx.save();
    ctx.lineCap = 'round';
    for (var z = 0; z < this.tsunamiZones.length; z++) {
      var zone = this.tsunamiZones[z];
      var fc = byCode[zone.code];
      if (!fc) continue;
      var color = TSUNAMI_COLORS[Math.min(fc.level, 3)];
      ctx.strokeStyle = color;
      ctx.globalAlpha = fc.level >= 2 ? blink : 0.85;
      ctx.lineWidth = fc.level >= 2 ? 3.2 : 2.2;
      ctx.beginPath();
      for (var k = 0; k < zone.coast.length; k++) {
        var pt = p.project(zone.coast[k][0], zone.coast[k][1]);
        if (pt[0] < -40 || pt[0] > this.cssWidth + 40 || pt[1] < -40 || pt[1] > this.cssHeight + 40) continue;
        ctx.moveTo(pt[0], pt[1]);
        ctx.lineTo(pt[0] + 0.6, pt[1]);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  };

  /* ---------------- 余震マーカー ---------------- */
  MapView.prototype.drawAftershocks = function (list) {
    if (!list || !list.length) return;
    var ctx = this.ctx, p = this.proj;
    ctx.save();
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      var pt = p.project(a.lat, a.lon);
      var r = Math.max(2, (a.magnitude - 2.5) * 2.0);
      ctx.beginPath();
      ctx.arc(pt[0], pt[1], r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(190, 70, 10, 0.8)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
    ctx.restore();
  };

  /* ---------------- 補助表示 ---------------- */
  MapView.prototype.drawScaleBar = function () {
    var ctx = this.ctx;
    var kmPerPx = this.proj.kmPerPixel();
    var target = 130;
    var raw = kmPerPx * target;
    var pow = Math.pow(10, Math.floor(Math.log10(raw)));
    var nice = [1, 2, 5, 10].map(function (m) { return m * pow; })
      .reduce(function (a, b) { return Math.abs(b - raw) < Math.abs(a - raw) ? b : a; });
    var px = nice / kmPerPx;

    var x = 16, y = this.cssHeight - 72;
    ctx.save();
    ctx.strokeStyle = 'rgba(30,50,70,.75)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(x, y - 4); ctx.lineTo(x, y); ctx.lineTo(x + px, y); ctx.lineTo(x + px, y - 4);
    ctx.stroke();
    ctx.fillStyle = 'rgba(20,40,60,.85)';
    ctx.font = '10px "SF Mono", monospace';
    ctx.fillText(nice >= 1 ? nice + ' km' : nice.toFixed(1) + ' km', x + px + 6, y);
    ctx.restore();
  };

  /* 設定モードの震源プレビュー (想定断層の地表投影つき) */
  MapView.prototype.drawSourcePreview = function (src, dim) {
    var ctx = this.ctx, p = this.proj;
    var c = p.project(src.lat, src.lon);

    if (dim) {
      // 走向方向に伸びる矩形として断層の地表投影を描く
      var halfL = p.kmToPixels(dim.length / 2);
      var halfW = p.kmToPixels(dim.width * Math.cos(src.dip * Math.PI / 180) / 2);
      ctx.save();
      ctx.translate(c[0], c[1]);
      ctx.rotate((src.strike - 90) * Math.PI / 180);
      ctx.strokeStyle = 'rgba(255, 176, 46, 0.85)';
      ctx.fillStyle = 'rgba(255, 176, 46, 0.10)';
      ctx.lineWidth = 1.4;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.rect(-halfL, -halfW, halfL * 2, Math.max(halfW * 2, 3));
      ctx.fill(); ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    ctx.strokeStyle = '#ffb02e';
    ctx.lineWidth = 2.6;
    ctx.lineCap = 'round';
    ctx.shadowColor = 'rgba(255,176,46,.8)';
    ctx.shadowBlur = 9;
    var s = 10;
    ctx.beginPath();
    ctx.moveTo(c[0] - s, c[1] - s); ctx.lineTo(c[0] + s, c[1] + s);
    ctx.moveTo(c[0] + s, c[1] - s); ctx.lineTo(c[0] - s, c[1] + s);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(c[0], c[1], s + 6, 0, Math.PI * 2);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  };

  MapView.prototype.clear = function () {
    this.drawBase();
    this.ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
    this.ctx.drawImage(this.base, 0, 0, this.cssWidth, this.cssHeight);
  };

  global.MapView = MapView;
})(window);
