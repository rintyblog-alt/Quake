/* 地図・観測点・波面の描画
 *
 * 背景 (海・陸・県境) は表示範囲が変わったときだけオフスクリーンに描き直し、
 * 毎フレームはそれを転送したうえで動く要素だけを描く。
 */
(function (global) {
  'use strict';

  /* 海底地形図が届くまでの下地。届いた後も画像の外側はこの色で埋める。 */
  var SEA_FALLBACK = '#16233a';
  /* 陸は都道府県で塗り分けず、一色のオリーブ灰にする */
  var LAND_FILL = '#5f6553';
  var LAND_LINE = 'rgba(214, 220, 200, 0.45)';   // 県境

  /* 津波の警報種別ごとの海岸線の色 */
  var TSUNAMI_COLORS = ['#4fc3f7', '#f5d020', '#e0231c', '#e838c8'];

  function MapView(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.min(global.devicePixelRatio || 1, 2);
    this.proj = new global.Projection(1, 1);

    this.geo = null;
    this.relief = null;      // 海底地形図 (Web メルカトルで焼いた 1 枚絵)
    this.reliefMeta = null;
    this.stations = null;
    this.tsunamiZones = null;

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

  /* 海底地形図。経度と mercY について線形な投影なので、
   * 画像の四隅を投影するだけで位置が合う。 */
  MapView.prototype.setRelief = function (img, meta) {
    this.relief = img;
    this.reliefMeta = meta;
    this.baseKey = '';
  };

  MapView.prototype.drawRelief = function (ctx) {
    var img = this.relief, m = this.reliefMeta, p = this.proj;
    if (!img || !m) return;
    var tl = p.project(m.north, m.west);
    var br = p.project(m.south, m.east);
    var w = br[0] - tl[0], h = br[1] - tl[1];
    if (w <= 0 || h <= 0) return;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, tl[0], tl[1], w, h);
  };
  MapView.prototype.setStations = function (s) {
    this.stations = s;
    // 観測点ごとの常時微動 [gal]。揺れていないときの色はこれで決まる。
    // 実際の微動は絶えず変わるので、種を持たせて時刻で揺らがせる。
    var n = s.lat.length, amb = new Float32Array(n), seed = new Int32Array(n);
    for (var i = 0; i < n; i++) {
      amb[i] = global.Util.ambientPGA(s.lat[i], s.lon[i], s.avs30 ? s.avs30[i] : 400);
      // 海底は脈動 (海のうねりが起こす常時微動) が陸より大きい
      if (s.seafloor && s.seafloor[i]) amb[i] *= SEAFLOOR_NOISE;
      seed[i] = global.Util.siteSeed(s.lat[i], s.lon[i]);
    }
    this.ambient = amb;
    this.ambientSeed = seed;
    this.noiseTime = 0;
    // 海底観測点 (S-net・DONET 相当) は震度のタイルにせず、点で色だけ出す
    this.seafloor = s.seafloor || null;
  };

  MapView.prototype.isSeafloor = function (i) {
    return !!(this.seafloor && this.seafloor[i]);
  };
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
    ctx.fillStyle = SEA_FALLBACK;
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);
    this.drawRelief(ctx);

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
      ctx.fillStyle = LAND_FILL;
      ctx.fill(path, 'evenodd');
    }

    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.min(1.1, 0.5 + p.zoom * 0.06);
    ctx.strokeStyle = LAND_LINE;
    ctx.stroke(borders);
    ctx.restore();
  };

  /* ---------------- 観測点 ---------------- */
  /* PGA の連続配色をこの段数に量子化して、同じ色をまとめて塗る */
  var PGA_BUCKETS = 56, PGA_LO = -2.1, PGA_HI = 3.0;
  var SEAFLOOR_NOISE = 3.0;   // 海底の常時微動は陸のおよそ 3 倍

  function pgaBucket(gal) {
    var t = (Math.log10(Math.max(gal, 1e-4)) - PGA_LO) / (PGA_HI - PGA_LO);
    return global.Util.clamp(Math.round(t * (PGA_BUCKETS - 1)), 0, PGA_BUCKETS - 1);
  }

  function bucketGal(b) {
    return Math.pow(10, PGA_LO + (PGA_HI - PGA_LO) * b / (PGA_BUCKETS - 1));
  }

  function bucketCSS(b) {
    return global.Util.pgaCSS(bucketGal(b));
  }

  /* 海底観測点の色。
   *
   * 海底の観測点は震度を発表しないので、揺れていないあいだは くすんだ黄緑で
   * 置いておき、実際に揺れ出したところから陸と同じ強震モニタの配色に移す。
   * 境目で色が飛ばないように、その間は混ぜる。 */
  var SEA_IDLE = [122, 124, 48];
  var SEA_LO = -0.6, SEA_HI = -0.05;      // log10(gal) の移り変わり

  function seafloorCSS(gal) {
    var lg = Math.log10(Math.max(gal, 1e-4));
    if (lg >= SEA_HI) return global.Util.pgaCSS(gal);
    // 静穏時は微動の強さで明るさだけ変える (点が生きて見えるように)
    var k = global.Util.clamp(0.62 + (lg + 1.6) * 0.42, 0.45, 1.15);
    var idle = [Math.round(SEA_IDLE[0] * k), Math.round(SEA_IDLE[1] * k),
                Math.round(SEA_IDLE[2] * k)];
    if (lg <= SEA_LO) return 'rgb(' + idle[0] + ',' + idle[1] + ',' + idle[2] + ')';
    var t = (lg - SEA_LO) / (SEA_HI - SEA_LO);
    var hot = global.Util.pgaRGB(gal);
    return 'rgb(' + Math.round(idle[0] + (hot[0] - idle[0]) * t) + ',' +
                    Math.round(idle[1] + (hot[1] - idle[1]) * t) + ',' +
                    Math.round(idle[2] + (hot[2] - idle[2]) * t) + ')';
  }

  function seaBucketCSS(b) { return seafloorCSS(bucketGal(b)); }

  /* 観測点の見かけの大きさ [gal]。揺れていなければ常時微動がそのまま出る。 */
  MapView.prototype.stationPGA = function (values, i) {
    var amb = 0.02;
    if (this.ambient) {
      amb = this.ambient[i] * global.Util.ambientFlicker(this.ambientSeed[i], this.noiseTime);
    }
    if (!values) return amb;
    return Math.max(global.Util.pgaFromIntensity(values[i]), amb);
  };

  /* 微動の揺らぎに使う時刻。再生を止めていても進める。 */
  MapView.prototype.tickNoise = function () {
    this.noiseTime = (global.performance ? global.performance.now() : Date.now()) / 1000;
  };

  MapView.prototype.drawStations = function (values) {
    if (!this.stations || !this.showStations) return;
    this.tickNoise();
    if (this.stationStyle === 'color') return this.drawStationsColor(values);

    var ctx = this.ctx, p = this.proj, U = global.Util;
    var lat = this.stations.lat, lon = this.stations.lon;
    var n = lat.length;
    var radius = U.clamp(7.0 * Math.pow(p.zoom, 0.40), 6.0, 22.0);
    var showNumber = radius >= 6.0;
    var margin = 26;

    var cell = radius * 1.62;
    var cols = Math.ceil((this.cssWidth + margin * 2) / cell) + 1;
    var isSea = this.seafloor;
    var sea = [];
    var best = {};
    var i;

    // まだ揺れていない観測点も同じ間引きに掛ける。ここで落としてしまうと
    // 波面の外側だけ観測点が消え、地図に不自然な円の縁ができる。
    // 海底観測点はもともと疎なので間引かず、陸の丸の取り合いにもしない。
    for (i = 0; i < n; i++) {
      var v = values ? values[i] : -3;
      var pt = p.project(lat[i], lon[i]);
      if (pt[0] < -margin || pt[0] > this.cssWidth + margin ||
          pt[1] < -margin || pt[1] > this.cssHeight + margin) continue;
      if (isSea && isSea[i]) {
        sea.push([pt[0], pt[1], this.stationPGA(values, i)]);
        continue;
      }
      var key = Math.floor((pt[1] + margin) / cell) * cols + Math.floor((pt[0] + margin) / cell);
      var cur = best[key];
      if (!cur || v > cur[2]) best[key] = [pt[0], pt[1], v, this.stationPGA(values, i)];
    }

    // 震度 0 に届かない観測点は、値に応じて大きさと濃さを落とした点で描く。
    // 段階を細かく取ることで、波面のところで見た目が急に切り替わらない。
    var quiet = new Array(PGA_BUCKETS);
    var groups = {};
    for (var key2 in best) {
      var e = best[key2];
      if (e[2] < -0.5) {
        var qb = pgaBucket(e[3]);
        (quiet[qb] || (quiet[qb] = [])).push(e);
        continue;
      }
      var cls0 = U.shindoClass(e[2]);
      (groups[cls0] || (groups[cls0] = [])).push([e[0], e[1]]);
    }

    ctx.save();
    var qr = Math.max(radius * 0.44, 2.4);
    for (var qb2 = 0; qb2 < PGA_BUCKETS; qb2++) {
      var qlist = quiet[qb2];
      if (!qlist) continue;
      var qpath = new Path2D();
      for (i = 0; i < qlist.length; i++) {
        qpath.moveTo(qlist[i][0] + qr, qlist[i][1]);
        qpath.arc(qlist[i][0], qlist[i][1], qr, 0, Math.PI * 2);
      }
      ctx.fillStyle = bucketCSS(qb2);
      ctx.fill(qpath);
    }
    ctx.restore();

    this.drawSeafloorDots(sea, qr);

    // 揺れているあいだは丸のまま。四角のタイルは地震情報 (確定) だけで使う。
    ctx = this.ctx;
    ctx.save();
    var order = U.shindoOrder;
    ctx.lineWidth = Math.max(1.6, radius * 0.17);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '800 ' + Math.round(radius * 1.18) + 'px ' + TILE_FONT;

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
    var paths = new Array(PGA_BUCKETS * 2);
    var sea = this.seafloor;
    var i, b;

    // 揺れていない観測点も含め、全点を同じ大きさの色の円で塗る
    for (i = 0; i < n; i++) {
      var pt = p.project(lat[i], lon[i]);
      if (pt[0] < -margin || pt[0] > this.cssWidth + margin ||
          pt[1] < -margin || pt[1] > this.cssHeight + margin) continue;
      b = pgaBucket(this.stationPGA(values, i));
      if (sea && sea[i]) b += PGA_BUCKETS;           // 海底は別のまとまりで塗る
      if (!paths[b]) paths[b] = new Path2D();
      paths[b].moveTo(pt[0] + radius, pt[1]);
      paths[b].arc(pt[0], pt[1], radius, 0, Math.PI * 2);
    }

    ctx.save();
    for (b = 0; b < PGA_BUCKETS * 2; b++) {
      if (!paths[b]) continue;
      var isSea = b >= PGA_BUCKETS;
      var gal = bucketGal(isSea ? b - PGA_BUCKETS : b);
      ctx.fillStyle = isSea ? seafloorCSS(gal) : U.pgaCSS(gal);
      ctx.shadowBlur = gal >= 5 ? 3 + Math.log10(gal / 5) * 6 : 0;
      ctx.shadowColor = ctx.fillStyle;
      ctx.fill(paths[b]);
    }
    ctx.restore();
  };

  /* ---------------- 地点震度のタイル ----------------
   * 角の丸い四角に震度を書いたもの。5弱・5強などは記号を肩に小さく付ける。
   * 弱いものから順に描いて、重なったときに強い震度が上に来るようにする。
   */
  var TILE_FONT = '"Hiragino Sans", "Noto Sans JP", "Yu Gothic", system-ui, sans-serif';

  function tileFont(px) { return '900 ' + px.toFixed(1) + 'px ' + TILE_FONT; }

  MapView.prototype.drawShindoTiles = function (groups, side) {
    var ctx = this.ctx, U = global.Util;
    var order = U.shindoOrder;
    var r = Math.max(2.0, side * 0.17);
    var half = side / 2, dy = side * 0.03;
    var big = tileFont(side * 0.60), small = tileFont(side * 0.40);
    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (var k = 0; k < order.length; k++) {
      var list = groups[order[k]];
      if (!list) continue;
      var cls = order[k], i;

      // 塗りはまとめて 1 つの影を落とす。縁は 1 枚ずつなぞるので、
      // 同じ震度どうしが重なっても継ぎ目が見える。
      var path = new Path2D();
      for (i = 0; i < list.length; i++) {
        roundRectPath(path, list[i][0] - half, list[i][1] - half, side, side, r);
      }
      ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
      ctx.shadowBlur = side * 0.18;
      ctx.shadowOffsetY = side * 0.06;
      ctx.fillStyle = U.shindoColor(cls);
      ctx.fill(path);
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
      ctx.lineWidth = Math.max(1.0, side * 0.040);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.42)';
      ctx.stroke(path);

      // 文字。フォントの切り替えは高いので、数字と肩の記号を別々にまとめて描く。
      var text = U.shindoShort(cls);
      var base = text.charAt(0), mark = text.length > 1 ? text.charAt(1) : '';
      ctx.fillStyle = U.shindoTextColor(cls);
      ctx.font = big;
      if (!mark) {
        ctx.textAlign = 'center';
        for (i = 0; i < list.length; i++) ctx.fillText(base, list[i][0], list[i][1] + dy);
        continue;
      }
      var bw = ctx.measureText(base).width;
      ctx.font = small;
      var mw = ctx.measureText(mark).width;
      var left = -(bw + mw) / 2;
      ctx.textAlign = 'left';
      ctx.font = big;
      for (i = 0; i < list.length; i++) ctx.fillText(base, list[i][0] + left, list[i][1] + dy);
      ctx.font = small;
      var mx = left + bw, my = dy - side * 0.17;
      for (i = 0; i < list.length; i++) ctx.fillText(mark, list[i][0] + mx, list[i][1] + my);
    }
    ctx.restore();
  };

  /* ---------------- 確定震度 (細分区域の塗り分け) ----------------
   * 震度速報は都道府県ではなく細分区域 (宮城県北部・南部など) の単位で
   * 発表されるため、陸域格子に割り当てた区域番号をもとに塗り分ける。
   */
  MapView.prototype.setSubdivisions = function (payload) {
    this.subCodes = payload.codes;
    this.subNames = payload.names;
    this.subCentroids = payload.centroids;
    // 区域ごとのポリゴン。量子化した差分の整数列で持っているので経度緯度に戻す。
    var quant = payload.quant || 100000;
    var polys = payload.polygons || {};
    this.subRings = new Array(this.subCodes.length);
    for (var a = 0; a < this.subCodes.length; a++) {
      var src = polys[this.subCodes[a]];
      if (!src) continue;
      var rings = new Array(src.length);
      for (var r = 0; r < src.length; r++) {
        var enc = src[r], n = enc.length >> 1;
        var ring = new Float64Array(enc.length);
        var x = 0, y = 0;
        for (var i = 0; i < n; i++) {
          x += enc[i * 2]; y += enc[i * 2 + 1];
          ring[i * 2] = x / quant;
          ring[i * 2 + 1] = y / quant;
        }
        rings[r] = ring;
      }
      this.subRings[a] = rings;
    }
    this._subCache = null;
  };

  /* 区域のポリゴンを今の投影で Path2D にする (表示範囲が変わるまで使い回す) */
  MapView.prototype._subPaths = function () {
    var key = this.viewKey();
    if (this._subCache && this._subCache.key === key) return this._subCache.paths;
    var p = this.proj, paths = new Array(this.subRings.length);
    var margin = 40;
    for (var a = 0; a < this.subRings.length; a++) {
      var rings = this.subRings[a];
      if (!rings) continue;
      var path = new Path2D(), any = false;
      for (var r = 0; r < rings.length; r++) {
        var ring = rings[r], n = ring.length >> 1;
        if (n < 3) continue;
        // 画面外のリングは飛ばす (拡大時に効く)
        var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        var pts = new Float64Array(ring.length);
        for (var i = 0; i < n; i++) {
          var pt = p.project(ring[i * 2 + 1], ring[i * 2]);
          pts[i * 2] = pt[0]; pts[i * 2 + 1] = pt[1];
          if (pt[0] < minX) minX = pt[0];
          if (pt[0] > maxX) maxX = pt[0];
          if (pt[1] < minY) minY = pt[1];
          if (pt[1] > maxY) maxY = pt[1];
        }
        if (maxX < -margin || minX > this.cssWidth + margin ||
            maxY < -margin || minY > this.cssHeight + margin) continue;
        path.moveTo(pts[0], pts[1]);
        for (i = 1; i < n; i++) path.lineTo(pts[i * 2], pts[i * 2 + 1]);
        path.closePath();
        any = true;
      }
      if (any) paths[a] = path;
    }
    this._subCache = { key: key, paths: paths };
    return paths;
  };

  MapView.prototype.drawObservedSubdivisions = function (areaIntensity) {
    if (!this.subRings) return;
    var ctx = this.ctx, U = global.Util;
    var paths = this._subPaths();
    // 同じ震度の区域はまとめて塗り、境目だけを白い線でなぞる
    var groups = {};
    for (var a = 0; a < paths.length; a++) {
      var v = areaIntensity[a];
      if (!paths[a] || !(v >= 0.5)) continue;
      var cls = U.shindoClass(v);
      (groups[cls] || (groups[cls] = [])).push(paths[a]);
    }
    ctx.save();
    ctx.globalAlpha = 0.88;
    var order = U.shindoOrder;
    for (var k = 0; k < order.length; k++) {
      var list = groups[order[k]];
      if (!list) continue;
      ctx.fillStyle = U.shindoColor(order[k]);
      for (var i = 0; i < list.length; i++) ctx.fill(list[i], 'evenodd');
    }
    ctx.globalAlpha = 1;
    ctx.lineJoin = 'round';
    ctx.lineWidth = 0.9;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
    for (k = 0; k < order.length; k++) {
      var l2 = groups[order[k]];
      if (!l2) continue;
      for (i = 0; i < l2.length; i++) ctx.stroke(l2[i]);
    }
    ctx.restore();
  };

  /* 確定震度のタイル。地点ごとではなく細分区域ごとに 1 つ置く。
   *
   * 地点の数だけ出すと画面が埋まってしまうので、区域の代表点にまとめる。
   * 重なるところは強い震度を残す (弱いほうを落とす)。 */
  MapView.prototype.drawSubdivisionTiles = function (areaIntensity) {
    if (!this.subCentroids) return;
    var p = this.proj, U = global.Util;
    var side = U.clamp(17.0 * Math.pow(p.zoom, 0.34), 17.0, 48.0);
    var entries = [];
    for (var a = 0; a < this.subCentroids.length; a++) {
      if (areaIntensity[a] >= 0.5) entries.push([a, areaIntensity[a]]);
    }
    entries.sort(function (x, y) { return y[1] - x[1]; });

    var placed = [], groups = {}, gap = side * 1.02;
    for (var k = 0; k < entries.length; k++) {
      var c = this.subCentroids[entries[k][0]];
      var pt = p.project(c[0], c[1]);
      if (pt[0] < -side || pt[0] > this.cssWidth + side ||
          pt[1] < -side || pt[1] > this.cssHeight + side) continue;
      var clash = false;
      for (var m = 0; m < placed.length; m++) {
        if (Math.abs(placed[m][0] - pt[0]) < gap && Math.abs(placed[m][1] - pt[1]) < gap) {
          clash = true; break;
        }
      }
      if (clash) continue;
      placed.push(pt);
      var cls = U.shindoClass(entries[k][1]);
      (groups[cls] || (groups[cls] = [])).push(pt);
    }
    this.drawShindoTiles(groups, side);
  };

  /* 確定表示のときの観測点 (区域のタイルを邪魔しない小さな点) */
  MapView.prototype.drawStationShindo = function (values) {
    if (!this.stations || !this.showStations || !values) return;
    var ctx = this.ctx, p = this.proj, U = global.Util;
    var lat = this.stations.lat, lon = this.stations.lon;
    var n = lat.length, margin = 16;
    var r = U.clamp(1.6 * Math.pow(p.zoom, 0.3), 1.3, 3.4);
    var isSea = this.seafloor;
    var groups = {}, sea = [], i;

    for (i = 0; i < n; i++) {
      var v = values[i];
      var pt = p.project(lat[i], lon[i]);
      if (pt[0] < -margin || pt[0] > this.cssWidth + margin ||
          pt[1] < -margin || pt[1] > this.cssHeight + margin) continue;
      if (isSea && isSea[i]) {
        sea.push([pt[0], pt[1], U.pgaFromIntensity(v)]);
        continue;
      }
      if (!(v >= 0.5)) continue;          // 震度 1 未満は発表しないので出さない
      var cls = U.shindoClass(v);
      var path = groups[cls] || (groups[cls] = new Path2D());
      path.moveTo(pt[0] + r, pt[1]);
      path.arc(pt[0], pt[1], r, 0, Math.PI * 2);
    }

    this.drawSeafloorDots(sea, Math.max(r * 1.5, 2.4));

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

  /* 海底観測点。震度のタイルは付けず、強震モニタと同じ連続配色の点で出す。 */
  MapView.prototype.drawSeafloorDots = function (list, r) {
    if (!list.length) return;
    var ctx = this.ctx;
    var paths = new Array(PGA_BUCKETS);
    for (var i = 0; i < list.length; i++) {
      var b = pgaBucket(list[i][2]);
      if (!paths[b]) paths[b] = new Path2D();
      paths[b].moveTo(list[i][0] + r, list[i][1]);
      paths[b].arc(list[i][0], list[i][1], r, 0, Math.PI * 2);
    }
    ctx.save();
    for (b = 0; b < PGA_BUCKETS; b++) {
      if (!paths[b]) continue;
      var gal = bucketGal(b);
      ctx.fillStyle = seaBucketCSS(b);
      ctx.shadowBlur = gal >= 5 ? 3 + Math.log10(gal / 5) * 6 : 0;
      ctx.shadowColor = ctx.fillStyle;
      ctx.fill(paths[b]);
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
  /* 揺れている範囲の囲み。塊ごとに 1 つ描き、
   * 弱い反応は緑、強い反応は黄にする。 */
  var BOX_WEAK = '80, 220, 120';
  var BOX_STRONG = '255, 213, 74';

  MapView.prototype.drawDetectionBoxes = function (boxes, phase, label) {
    if (!boxes || !boxes.length) return;
    var ctx = this.ctx, p = this.proj;
    var margin = 30;
    ctx.save();
    ctx.lineJoin = 'miter';
    for (var i = 0; i < boxes.length; i++) {
      var box = boxes[i];
      var a = p.project(box.latMax, box.lonMin);
      var b = p.project(box.latMin, box.lonMax);
      var x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]);
      var w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]);
      if (x > this.cssWidth + margin || y > this.cssHeight + margin ||
          x + w < -margin || y + h < -margin) continue;
      var pad = 5;
      x -= pad; y -= pad; w += pad * 2; h += pad * 2;

      var rgb = box.strong ? BOX_STRONG : BOX_WEAK;
      ctx.strokeStyle = 'rgba(' + rgb + ', 0.95)';
      ctx.lineWidth = box.strong ? 2.0 : 1.5;
      ctx.strokeRect(x, y, w, h);

      // いちばん強い塊だけ、四隅を太くして目立たせる
      if (i === 0 && box.strong) {
        ctx.lineWidth = 3.2;
        var c = Math.min(18, w / 3, h / 3);
        var corners = [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]];
        for (var k = 0; k < corners.length; k++) {
          var q = corners[k];
          ctx.beginPath();
          ctx.moveTo(q[0] + q[2] * c, q[1]);
          ctx.lineTo(q[0], q[1]);
          ctx.lineTo(q[0], q[1] + q[3] * c);
          ctx.stroke();
        }
      }

      if (label && i === 0) {
        ctx.fillStyle = 'rgba(' + rgb + ', 0.95)';
        ctx.font = '700 13px "Hiragino Sans", system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText('揺れを検出', x + 2, y - 5);
      }
    }
    ctx.restore();
  };

  /* ---------------- 津波 ---------------- */
  MapView.prototype.drawTsunami = function (forecast, elapsed) {
    if (!forecast || !this.tsunamiZones) return;
    var ctx = this.ctx, p = this.proj;
    var byCode = {};
    for (var i = 0; i < forecast.zones.length; i++) byCode[forecast.zones[i].code] = forecast.zones[i];
    var blink = 0.78 + 0.22 * Math.sin(elapsed * 3.0);

    // 沿岸は格子点の列なので、点を太く打って帯にする。格子の間隔ぶんの
    // 太さを下限にすることで、拡大しても切れ切れにならない。
    var span = Math.max(p.kmToPixels(2.6), 0.5);

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // 弱い段から描いて、警報・大津波警報が上に来るようにする
    var order = [];
    for (var z = 0; z < this.tsunamiZones.length; z++) {
      var fc0 = byCode[this.tsunamiZones[z].code];
      if (fc0) order.push([z, Math.min(fc0.level, 3)]);
    }
    order.sort(function (a, b) { return a[1] - b[1]; });

    for (var q = 0; q < order.length; q++) {
      var zone = this.tsunamiZones[order[q][0]];
      var fc = byCode[zone.code], lv = order[q][1];
      var color = TSUNAMI_COLORS[lv];
      var width = Math.max(lv >= 3 ? 13 : (lv >= 2 ? 11 : (lv >= 1 ? 9 : 7)), span * 1.7);
      var path = new Path2D();
      for (var k = 0; k < zone.coast.length; k++) {
        var pt = p.project(zone.coast[k][0], zone.coast[k][1]);
        if (pt[0] < -60 || pt[0] > this.cssWidth + 60 ||
            pt[1] < -60 || pt[1] > this.cssHeight + 60) continue;
        path.moveTo(pt[0], pt[1]);
        path.lineTo(pt[0] + 0.7, pt[1]);
      }
      // 外側にうっすら光らせてから、本体を重ねる
      ctx.globalAlpha = (lv >= 2 ? blink : 0.9) * 0.5;
      ctx.strokeStyle = color;
      ctx.lineWidth = width * 1.9;
      ctx.stroke(path);
      ctx.globalAlpha = lv >= 2 ? blink : 0.95;
      ctx.lineWidth = width;
      ctx.stroke(path);
    }

    // 予想高さを棒で示す
    ctx.globalAlpha = 1;
    for (i = 0; i < forecast.zones.length; i++) {
      var f = forecast.zones[i];
      if (f.level < 1) continue;
      var c = p.project(f.lat, f.lon);
      if (c[0] < 0 || c[0] > this.cssWidth || c[1] < 0 || c[1] > this.cssHeight) continue;
      var hgt = Math.min(16 + Math.log10(1 + f.height) * 64, 104);
      ctx.strokeStyle = TSUNAMI_COLORS[Math.min(f.level, 3)];
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.moveTo(c[0], c[1]);
      ctx.lineTo(c[0], c[1] - hgt);
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
    roundRectPath(ctx, x, y, w, h, r);
  }

  /* ctx にも Path2D にも同じように積める角丸の四角 */
  function roundRectPath(path, x, y, w, h, r) {
    path.moveTo(x + r, y);
    path.arcTo(x + w, y, x + w, y + h, r);
    path.arcTo(x + w, y + h, x, y + h, r);
    path.arcTo(x, y + h, x, y, r);
    path.arcTo(x, y, x + w, y, r);
    path.closePath();
  }

  global.MapView = MapView;
})(window);
