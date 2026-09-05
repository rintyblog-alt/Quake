/* 地図・観測点・波面の描画
 *
 * 背景 (海・陸・県境) は表示範囲が変わったときだけオフスクリーンに描き直し、
 * 毎フレームはそれを転送したうえで動く要素だけを描く。
 */
(function (global) {
  'use strict';

  var SEA_TOP = '#1d2c46';
  var SEA_BOTTOM = '#0e1727';
  var LAND_LINE = '#24384a';
  var COAST_LINE = '#4a6a84';

  /* 陸は都道府県ごとに落ち着いた色を割り当てる (政治地図のような塗り分け) */
  var LAND_PALETTE = [
    '#4f8b74', '#94a05a', '#6a8fae', '#a89566', '#6ea08e', '#8a8bab', '#7d9a62'
  ];

  /* 津波の警報種別ごとの海岸線の色 */
  var TSUNAMI_COLORS = ['#4fc3f7', '#f5d020', '#e0231c', '#e838c8'];

  function MapView(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.min(global.devicePixelRatio || 1, 2);
    this.proj = new global.Projection(1, 1);

    this.geo = null;
    this.stations = null;
    this.tsunamiZones = null;
    this.subGrid = null;

    this.base = document.createElement('canvas');
    this.baseCtx = this.base.getContext('2d');
    this.baseKey = '';

    this.showStations = true;
    this.stationStyle = 'number';   // 'number' = 震度の数字入りの円 / 'color' = 色のみ
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
    this._subCache = null;
  };

  MapView.prototype.setGeo = function (geojson) { this.geo = geojson; this.baseKey = ''; };
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
    sea.addColorStop(0, SEA_TOP);
    sea.addColorStop(1, SEA_BOTTOM);
    ctx.fillStyle = sea;
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);

    var tl = p.unproject(-80, -80);
    var br = p.unproject(this.cssWidth + 80, this.cssHeight + 80);
    var latMin = Math.min(tl[0], br[0]), latMax = Math.max(tl[0], br[0]);
    var lonMin = Math.min(tl[1], br[1]), lonMax = Math.max(tl[1], br[1]);

    var borders = new Path2D();
    var feats = this.geo.features;

    for (var f = 0; f < feats.length; f++) {
      var feat = feats[f];
      var path = new Path2D();
      var any = false;
      var polys = feat.geometry.coordinates;
      for (var q = 0; q < polys.length; q++) {
        var rings = polys[q];
        for (var r = 0; r < rings.length; r++) {
          var ring = rings[r];
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
            if (!started) { path.moveTo(pt[0], pt[1]); borders.moveTo(pt[0], pt[1]); started = true; }
            else { path.lineTo(pt[0], pt[1]); borders.lineTo(pt[0], pt[1]); }
          }
          if (started) { path.closePath(); borders.closePath(); any = true; }
        }
      }
      if (!any) continue;
      ctx.fillStyle = LAND_PALETTE[(feat.properties.id || 0) % LAND_PALETTE.length];
      ctx.fill(path, 'evenodd');
    }

    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.min(1.0, 0.4 + p.zoom * 0.07);
    ctx.strokeStyle = LAND_LINE;
    ctx.stroke(borders);
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = Math.min(1.6, 0.7 + p.zoom * 0.06);
    ctx.strokeStyle = COAST_LINE;
    ctx.stroke(borders);
    ctx.globalAlpha = 1;
    ctx.restore();
  };

  /* ---------------- 観測点 ---------------- */
  MapView.prototype.drawStations = function (values) {
    if (!this.stations || !this.showStations) return;
    if (this.stationStyle === 'color') return this.drawStationsColor(values);

    var ctx = this.ctx, p = this.proj, U = global.Util;
    var lat = this.stations.lat, lon = this.stations.lon;
    var n = lat.length;
    var radius = U.clamp(7.0 * Math.pow(p.zoom, 0.40), 6.0, 22.0);
    var showNumber = radius >= 6.0;
    var margin = 26;

    var faint = new Path2D();
    var cell = radius * 1.62;
    var cols = Math.ceil((this.cssWidth + margin * 2) / cell) + 1;
    var best = {};
    var i;

    for (i = 0; i < n; i++) {
      var v = values ? values[i] : -3;
      var pt = p.project(lat[i], lon[i]);
      if (pt[0] < -margin || pt[0] > this.cssWidth + margin ||
          pt[1] < -margin || pt[1] > this.cssHeight + margin) continue;
      if (v < -0.5) {
        faint.moveTo(pt[0] + 1.4, pt[1]);
        faint.arc(pt[0], pt[1], 1.4, 0, Math.PI * 2);
        continue;
      }
      var key = Math.floor((pt[1] + margin) / cell) * cols + Math.floor((pt[0] + margin) / cell);
      var cur = best[key];
      if (!cur || v > cur[2]) best[key] = [pt[0], pt[1], v];
    }

    var groups = {};
    for (var key2 in best) {
      var e = best[key2];
      var cls0 = U.shindoClass(e[2]);
      (groups[cls0] || (groups[cls0] = [])).push([e[0], e[1]]);
    }

    ctx.save();
    ctx.fillStyle = 'rgba(150, 175, 200, 0.35)';
    ctx.fill(faint);

    var order = U.shindoOrder;
    ctx.lineWidth = Math.max(1.6, radius * 0.17);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '800 ' + Math.round(radius * 1.18) + 'px "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif';

    for (var k = 0; k < order.length; k++) {
      var list = groups[order[k]];
      if (!list) continue;
      var path = new Path2D();
      for (i = 0; i < list.length; i++) {
        path.moveTo(list[i][0] + radius, list[i][1]);
        path.arc(list[i][0], list[i][1], radius, 0, Math.PI * 2);
      }
      ctx.fillStyle = U.shindoColor(order[k]);
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
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

  /* 色だけの円 (強震モニタ風の連続配色) */
  MapView.prototype.drawStationsColor = function (values) {
    var ctx = this.ctx, p = this.proj, U = global.Util;
    var lat = this.stations.lat, lon = this.stations.lon;
    var n = lat.length;
    var radius = U.clamp(2.6 * Math.pow(p.zoom, 0.35), 2.0, 7.0);
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
      ctx.shadowBlur = val >= 2.5 ? 3 + (val - 2.5) * 3 : 0;
      ctx.shadowColor = ctx.fillStyle;
      ctx.fill(paths[b]);
    }
    ctx.restore();
  };

  /* ---------------- 確定震度 (細分区域の塗り分け) ----------------
   * 震度速報は都道府県ではなく細分区域 (宮城県北部・南部など) の単位で
   * 発表されるため、陸域格子に割り当てた区域番号をもとに塗り分ける。
   */
  MapView.prototype.setSubdivisions = function (payload, landmask) {
    this.subCodes = payload.codes;
    this.subNames = payload.names;
    this.subCentroids = payload.centroids;

    var bin = atob(payload.cells);
    var cells = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) cells[i] = bin.charCodeAt(i);

    var nLat = landmask.nLat, nLon = landmask.nLon;
    var grid = new Uint8Array(nLat * nLon);
    grid.fill(255);
    var bytes = landmask.bytes, k = 0;
    for (var b = 0; b < nLat * nLon; b++) {
      if (bytes[b >> 3] & (128 >> (b & 7))) grid[b] = cells[k++];
    }
    this.subGrid = grid;
    this.subMask = landmask;
    this._subCache = null;
  };

  MapView.prototype.drawObservedSubdivisions = function (areaIntensity) {
    if (!this.subGrid) return;
    var key = this.viewKey() + '|' + (this._subStamp || 0);
    if (!this._subCache || this._subCache.key !== key) {
      this._subCache = { key: key, canvas: this._renderSubdivisions(areaIntensity) };
    }
    if (this._subCache.canvas) {
      this.ctx.drawImage(this._subCache.canvas, 0, 0, this.cssWidth, this.cssHeight);
    }
  };

  MapView.prototype._renderSubdivisions = function (areaIntensity) {
    var U = global.Util, p = this.proj, m = this.subMask;
    var w = this.cssWidth, h = this.cssHeight;
    if (w < 2 || h < 2) return null;

    var n = this.subCodes.length;
    var cr = new Uint8Array(n), cg = new Uint8Array(n), cb = new Uint8Array(n), ca = new Uint8Array(n);
    for (var a = 0; a < n; a++) {
      var v = areaIntensity[a];
      if (!(v >= 0.5)) continue;
      var hex = U.shindoColor(U.shindoClass(v));
      cr[a] = parseInt(hex.slice(1, 3), 16);
      cg[a] = parseInt(hex.slice(3, 5), 16);
      cb[a] = parseInt(hex.slice(5, 7), 16);
      ca[a] = 225;
    }

    var rowIdx = new Int32Array(h), colIdx = new Int32Array(w);
    var y, x;
    for (y = 0; y < h; y++) {
      var gi = Math.floor((p.unproject(0, y + 0.5)[0] - m.latMin) / m.step);
      rowIdx[y] = (gi >= 0 && gi < m.nLat) ? gi : -1;
    }
    for (x = 0; x < w; x++) {
      var gj = Math.floor((p.unproject(x + 0.5, 0)[1] - m.lonMin) / m.step);
      colIdx[x] = (gj >= 0 && gj < m.nLon) ? gj : -1;
    }

    var off = document.createElement('canvas');
    off.width = w; off.height = h;
    var octx = off.getContext('2d');
    var img = octx.createImageData(w, h);
    var data = img.data;
    var grid = this.subGrid, nLon = m.nLon;

    for (y = 0; y < h; y++) {
      var ri = rowIdx[y];
      if (ri < 0) continue;
      var rowOff = ri * nLon, base = y * w * 4, prev = 255;
      for (x = 0; x < w; x++) {
        var ci = colIdx[x];
        if (ci < 0) { prev = 255; continue; }
        var area = grid[rowOff + ci];
        var o = base + x * 4;
        if (area !== 255 && ca[area]) {
          if (prev !== 255 && prev !== area && ca[prev]) {
            data[o] = 255; data[o + 1] = 255; data[o + 2] = 255; data[o + 3] = 235;
          } else {
            data[o] = cr[area]; data[o + 1] = cg[area];
            data[o + 2] = cb[area]; data[o + 3] = ca[area];
          }
        }
        prev = area;
      }
    }
    octx.putImageData(img, 0, 0);
    return off;
  };

  MapView.prototype.drawSubdivisionBadges = function (areaIntensity) {
    if (!this.subCentroids) return;
    var ctx = this.ctx, p = this.proj, U = global.Util;
    var placed = [];
    var entries = [];
    for (var a = 0; a < this.subCentroids.length; a++) {
      if (areaIntensity[a] >= 0.5) entries.push([a, areaIntensity[a]]);
    }
    entries.sort(function (x, y) { return y[1] - x[1]; });

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (var k = 0; k < entries.length; k++) {
      var c = this.subCentroids[entries[k][0]];
      var pt = p.project(c[0], c[1]);
      if (pt[0] < 12 || pt[0] > this.cssWidth - 12 || pt[1] < 12 || pt[1] > this.cssHeight - 12) continue;
      var w = 30, h = 26, clash = false;
      for (var m = 0; m < placed.length; m++) {
        if (Math.abs(placed[m][0] - pt[0]) < w * 1.1 && Math.abs(placed[m][1] - pt[1]) < h * 1.1) {
          clash = true; break;
        }
      }
      if (clash) continue;
      placed.push(pt);

      var cls = U.shindoClass(entries[k][1]);
      roundRect(ctx, pt[0] - w / 2, pt[1] - h / 2, w, h, 6);
      ctx.fillStyle = U.shindoColor(cls);
      ctx.fill();
      ctx.lineWidth = 2.2;
      ctx.strokeStyle = 'rgba(255,255,255,.95)';
      ctx.stroke();
      ctx.fillStyle = U.shindoTextColor(cls);
      ctx.font = '800 16px "SF Mono", "Roboto Mono", monospace';
      ctx.fillText(U.shindoShort(cls), pt[0], pt[1] + 1);
    }
    ctx.restore();
  };

  /* 確定表示のときの観測点 (区域の塗り分けを邪魔しない小さな点) */
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
    ctx.globalAlpha = 0.85;
    for (var cls2 in groups) {
      ctx.fillStyle = U.shindoColor(cls2);
      ctx.fill(groups[cls2]);
      ctx.lineWidth = 0.7;
      ctx.strokeStyle = 'rgba(255,255,255,.7)';
      ctx.stroke(groups[cls2]);
    }
    ctx.restore();
  };

  /* ---------------- 波面 ---------------- */
  MapView.prototype.drawWavefronts = function (lat, lon, pRadiusKm, sRadiusKm) {
    var ctx = this.ctx, p = this.proj;
    var c = p.project(lat, lon);

    // S 波の内側を淡い紫で染める
    if (sRadiusKm > 0) {
      var rs = p.kmToPixels(sRadiusKm);
      if (rs > 1 && rs < 30000) {
        ctx.save();
        var g = ctx.createRadialGradient(c[0], c[1], 0, c[0], c[1], rs);
        g.addColorStop(0, 'rgba(150, 30, 190, 0.40)');
        g.addColorStop(0.6, 'rgba(150, 30, 190, 0.22)');
        g.addColorStop(1, 'rgba(150, 30, 190, 0.08)');
        ctx.beginPath();
        ctx.arc(c[0], c[1], rs, 0, Math.PI * 2);
        ctx.fillStyle = g;
        ctx.fill();
        ctx.lineWidth = 2.6;
        ctx.strokeStyle = 'rgba(238, 56, 200, 0.95)';
        ctx.stroke();
        ctx.restore();
      }
    }
    // P 波は細い水色の破線
    if (pRadiusKm > 0) {
      var rp = p.kmToPixels(pRadiusKm);
      if (rp > 1 && rp < 30000) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(c[0], c[1], rp, 0, Math.PI * 2);
        ctx.setLineDash([8, 6]);
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = 'rgba(120, 210, 255, 0.85)';
        ctx.stroke();
        ctx.restore();
      }
    }
  };

  /* ---------------- 震源 ---------------- */
  MapView.prototype.drawEpicenter = function (lat, lon, pulse) {
    var ctx = this.ctx, p = this.proj;
    var c = p.project(lat, lon);
    var s = 21;

    // 震源のまわりの暗い光輪
    ctx.save();
    var g = ctx.createRadialGradient(c[0], c[1], 0, c[0], c[1], s * 3.4);
    g.addColorStop(0, 'rgba(40, 0, 60, 0.75)');
    g.addColorStop(1, 'rgba(40, 0, 60, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(c[0], c[1], s * 3.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    if (pulse > 0) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, 0.8 - pulse);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(c[0], c[1], s + pulse * 28, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // 赤い縁取りの白い ✕
    ctx.save();
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(c[0] - s, c[1] - s); ctx.lineTo(c[0] + s, c[1] + s);
    ctx.moveTo(c[0] + s, c[1] - s); ctx.lineTo(c[0] - s, c[1] + s);
    ctx.strokeStyle = 'rgba(60, 0, 30, 0.85)';
    ctx.lineWidth = 13;
    ctx.stroke();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 8;
    ctx.stroke();
    ctx.restore();
  };

  /* 断層面の地表投影 (破壊の進行)
   * 小断層を点で描くと格子模様が見えてしまうため、破壊済みの範囲を
   * 凸包で囲んだ面として描く。 */
  MapView.prototype.drawRupture = function (rupture, progressSec) {
    if (!rupture || !rupture.lat) return;
    var p = this.proj, pts = [];
    for (var i = 0; i < rupture.lat.length; i++) {
      if (rupture.delay[i] > progressSec) continue;
      pts.push(p.project(rupture.lat[i], rupture.lon[i]));
    }
    if (pts.length < 3) return;
    var hull = convexHull(pts);
    if (hull.length < 3) return;

    var ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(hull[0][0], hull[0][1]);
    for (var k = 1; k < hull.length; k++) ctx.lineTo(hull[k][0], hull[k][1]);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 140, 40, 0.18)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 170, 70, 0.7)';
    ctx.lineWidth = 1.6;
    ctx.setLineDash([7, 5]);
    ctx.stroke();
    ctx.restore();
  };

  /* 凸包 (Andrew の monotone chain) */
  function convexHull(points) {
    var pts = points.slice().sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    if (pts.length < 3) return pts;
    function cross(o, a, b) {
      return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    }
    var lower = [], upper = [], i;
    for (i = 0; i < pts.length; i++) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pts[i]) <= 0) lower.pop();
      lower.push(pts[i]);
    }
    for (i = pts.length - 1; i >= 0; i--) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pts[i]) <= 0) upper.pop();
      upper.push(pts[i]);
    }
    lower.pop(); upper.pop();
    return lower.concat(upper);
  }

  /* ---------------- 検知の演出 ----------------
   * 揺れを検出した観測点を囲む四角を描き、広がっていく様子を見せる。 */
  MapView.prototype.drawDetectionBox = function (box, phase) {
    if (!box) return;
    var ctx = this.ctx, p = this.proj;
    var a = p.project(box.latMax, box.lonMin);
    var b = p.project(box.latMin, box.lonMax);
    var x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]);
    var w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]);
    var pad = 14 + 10 * Math.sin(phase * 4.0);
    x -= pad; y -= pad; w += pad * 2; h += pad * 2;

    ctx.save();
    ctx.strokeStyle = 'rgba(255, 213, 74, 0.95)';
    ctx.lineWidth = 2.2;
    ctx.setLineDash([10, 6]);
    ctx.lineDashOffset = -phase * 26;
    ctx.strokeRect(x, y, w, h);

    // 四隅を実線で強調する
    ctx.setLineDash([]);
    ctx.lineWidth = 3.4;
    var c = Math.min(24, w / 3, h / 3);
    var corners = [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]];
    for (var i = 0; i < corners.length; i++) {
      var q = corners[i];
      ctx.beginPath();
      ctx.moveTo(q[0] + q[2] * c, q[1]);
      ctx.lineTo(q[0], q[1]);
      ctx.lineTo(q[0], q[1] + q[3] * c);
      ctx.stroke();
    }

    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255, 213, 74, 0.95)';
    ctx.font = '700 13px "Hiragino Sans", system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText('揺れを検出', x + 2, y - 5);
    ctx.restore();
  };

  /* ---------------- 津波 ---------------- */
  MapView.prototype.drawTsunami = function (forecast, elapsed) {
    if (!forecast || !this.tsunamiZones) return;
    var ctx = this.ctx, p = this.proj;
    var byCode = {};
    for (var i = 0; i < forecast.zones.length; i++) byCode[forecast.zones[i].code] = forecast.zones[i];
    var blink = 0.6 + 0.4 * Math.sin(elapsed * 3.0);

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (var z = 0; z < this.tsunamiZones.length; z++) {
      var zone = this.tsunamiZones[z];
      var fc = byCode[zone.code];
      if (!fc) continue;
      ctx.strokeStyle = TSUNAMI_COLORS[Math.min(fc.level, 3)];
      ctx.globalAlpha = fc.level >= 2 ? blink : 0.9;
      ctx.lineWidth = fc.level >= 3 ? 5.5 : (fc.level >= 2 ? 4.5 : 3.5);
      ctx.beginPath();
      for (var k = 0; k < zone.coast.length; k++) {
        var pt = p.project(zone.coast[k][0], zone.coast[k][1]);
        if (pt[0] < -40 || pt[0] > this.cssWidth + 40 || pt[1] < -40 || pt[1] > this.cssHeight + 40) continue;
        ctx.moveTo(pt[0], pt[1]);
        ctx.lineTo(pt[0] + 0.7, pt[1]);
      }
      ctx.stroke();
    }

    // 予想高さを棒で示す
    ctx.globalAlpha = 1;
    for (i = 0; i < forecast.zones.length; i++) {
      var f = forecast.zones[i];
      if (f.level < 1) continue;
      var q = p.project(f.lat, f.lon);
      if (q[0] < 0 || q[0] > this.cssWidth || q[1] < 0 || q[1] > this.cssHeight) continue;
      var hgt = Math.min(12 + Math.log10(1 + f.height) * 58, 92);
      ctx.strokeStyle = TSUNAMI_COLORS[Math.min(f.level, 3)];
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(q[0], q[1]);
      ctx.lineTo(q[0], q[1] - hgt);
      ctx.stroke();
    }
    ctx.restore();
  };

  /* ---------------- 余震 ---------------- */
  MapView.prototype.drawAftershocks = function (list) {
    if (!list || !list.length) return;
    var ctx = this.ctx, p = this.proj;
    ctx.save();
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      var pt = p.project(a.lat, a.lon);
      ctx.beginPath();
      ctx.arc(pt[0], pt[1], Math.max(2, (a.magnitude - 2.5) * 2.0), 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255, 190, 90, 0.8)';
      ctx.lineWidth = 1.3;
      ctx.stroke();
    }
    ctx.restore();
  };

  /* ---------------- 補助 ---------------- */
  MapView.prototype.drawScaleBar = function () {
    var ctx = this.ctx;
    var kmPerPx = this.proj.kmPerPixel();
    var raw = kmPerPx * 130;
    var pow = Math.pow(10, Math.floor(Math.log10(raw)));
    var nice = [1, 2, 5, 10].map(function (m) { return m * pow; })
      .reduce(function (a, b) { return Math.abs(b - raw) < Math.abs(a - raw) ? b : a; });
    var px = nice / kmPerPx;
    var x = 16, y = this.cssHeight - 20;
    ctx.save();
    ctx.strokeStyle = 'rgba(220,235,250,.7)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y - 4); ctx.lineTo(x, y); ctx.lineTo(x + px, y); ctx.lineTo(x + px, y - 4);
    ctx.stroke();
    ctx.fillStyle = 'rgba(220,235,250,.85)';
    ctx.font = '10px "SF Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText(nice >= 1 ? nice + ' km' : nice.toFixed(1) + ' km', x + px + 6, y);
    ctx.restore();
  };

  /* 設定モードの震源プレビュー */
  MapView.prototype.drawSourcePreview = function (src, dim) {
    var ctx = this.ctx, p = this.proj;
    var c = p.project(src.lat, src.lon);
    if (dim) {
      var halfL = p.kmToPixels(dim.length / 2);
      var halfW = p.kmToPixels(dim.width * Math.cos(src.dip * Math.PI / 180) / 2);
      ctx.save();
      ctx.translate(c[0], c[1]);
      ctx.rotate((src.strike - 90) * Math.PI / 180);
      ctx.strokeStyle = 'rgba(255, 213, 74, 0.85)';
      ctx.fillStyle = 'rgba(255, 213, 74, 0.10)';
      ctx.lineWidth = 1.4;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.rect(-halfL, -halfW, halfL * 2, Math.max(halfW * 2, 3));
      ctx.fill(); ctx.stroke();
      ctx.restore();
    }
    ctx.save();
    ctx.strokeStyle = '#ffd54a';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    var s = 11;
    ctx.beginPath();
    ctx.moveTo(c[0] - s, c[1] - s); ctx.lineTo(c[0] + s, c[1] + s);
    ctx.moveTo(c[0] + s, c[1] - s); ctx.lineTo(c[0] - s, c[1] + s);
    ctx.stroke();
    ctx.restore();
  };

  MapView.prototype.clear = function () {
    this.drawBase();
    this.ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
    this.ctx.drawImage(this.base, 0, 0, this.cssWidth, this.cssHeight);
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

  global.MapView = MapView;
})(window);
