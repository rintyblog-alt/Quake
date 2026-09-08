/* 全体制御: データ読み込み・モード切替・再生・描画ループ
 *
 * 再生は 3 つの段階を進む。
 *   detect  観測点が揺れを検出した範囲を四角で囲んで示す (発震直後)
 *   monitor 緊急地震速報と P/S 波の広がりを示す
 *   final   揺れが収まったあとの確定震度を細分区域で塗り分ける
 */
(function (global) {
  'use strict';

  var U = global.Util, P = global.Panels;
  function el(id) { return document.getElementById(id); }

  /* ================= 陸域マスク ================= */
  function LandMask(payload) {
    this.latMin = payload.lat_min; this.lonMin = payload.lon_min;
    this.step = payload.step; this.nLat = payload.n_lat; this.nLon = payload.n_lon;
    var bin = atob(payload.bits);
    this.bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) this.bytes[i] = bin.charCodeAt(i);
  }
  LandMask.prototype.isLand = function (lat, lon) {
    var i = Math.floor((lat - this.latMin) / this.step);
    var j = Math.floor((lon - this.lonMin) / this.step);
    if (i < 0 || i >= this.nLat || j < 0 || j >= this.nLon) return false;
    var bit = i * this.nLon + j;
    return (this.bytes[bit >> 3] & (128 >> (bit & 7))) !== 0;
  };
  LandMask.prototype.blocked = function (lat1, lon1, lat2, lon2) {
    var total = U.haversine(lat1, lon1, lat2, lon2);
    if (total <= 15) return false;
    var span = (total - 15) / total;
    var n = Math.max(Math.floor((total - 15) / 5), 2);
    for (var k = 0; k <= n; k++) {
      var f = span * k / n;
      if (this.isLand(lat1 + (lat2 - lat1) * f, lon1 + (lon2 - lon1) * f)) return true;
    }
    return false;
  };

  /* ================= 震央地名 ================= */
  /* 国内の海域名の代表点からこれだけ離れていて、遠地の地名のほうが近ければそちらを使う [km] */
  var WORLD_THRESHOLD_KM = 300.0;

  function Regions(regionsJson, stations, landmask) {
    this.list = regionsJson.regions;
    this.byCode = {};
    this.seaLat = []; this.seaLon = []; this.seaRef = [];
    this.world = [];
    for (var i = 0; i < this.list.length; i++) {
      var r = this.list[i];
      this.byCode[r.code] = r;
      if (r.type === 'world') this.world.push(r);
      if (r.type === 'sea') {
        var anchors = r.anchors || [[r.lat, r.lon]];
        for (var k = 0; k < anchors.length; k++) {
          this.seaLat.push(anchors[k][0]); this.seaLon.push(anchors[k][1]); this.seaRef.push(r);
        }
      }
    }
    this.stations = stations;
    this.landmask = landmask;
  }
  Regions.prototype.nameByCode = function (code) {
    var r = this.byCode[code];
    return r ? r.name : '';
  };
  Regions.prototype.nameAt = function (lat, lon) {
    var st = this.stations, best = -1, bestD = Infinity, i;
    for (i = 0; i < st.lat.length; i++) {
      var d = U.haversine(lat, lon, st.lat[i], st.lon[i]);
      if (d < bestD) { bestD = d; best = i; }
    }
    var onLand = this.landmask ? this.landmask.isLand(lat, lon) : bestD <= 15;
    var landCode = best >= 0 ? st.region[best] : '';
    if (onLand && this.byCode[landCode]) return this.byCode[landCode].name;
    var sBest = -1, sD = Infinity;
    for (i = 0; i < this.seaLat.length; i++) {
      var ds = U.haversine(lat, lon, this.seaLat[i], this.seaLon[i]);
      if (ds < sD) { sD = ds; sBest = i; }
    }
    if (bestD < 3 && bestD < sD && this.byCode[landCode]) return this.byCode[landCode].name;

    // 国内の区分から離れていれば、遠地地震の大まかな地名を使う
    if (this.world.length && sD > WORLD_THRESHOLD_KM) {
      var wBest = -1, wD = Infinity;
      for (i = 0; i < this.world.length; i++) {
        var dw = U.haversine(lat, lon, this.world[i].lat, this.world[i].lon);
        if (dw < wD) { wD = dw; wBest = i; }
      }
      if (wBest >= 0 && wD < sD) return this.world[wBest].name;
    }
    return sBest >= 0 ? this.seaRef[sBest].name : '';
  };

  /* ================= アプリ本体 ================= */
  var App = {
    mode: 'visual',
    phase: 'detect',
    playing: false,
    t: 0,
    speed: 1,
    current: null,
    history: [],
    recentResults: [],
    activeRecent: 0,
    lastFrame: 0,
    firedReports: 0,
    firedTsunami: false,
    drill: true,
    panelOn: { info: true, wave: true, tsunami: true, sound: true }
  };

  function fetchJSON(path) {
    var bundled = global.__BUNDLED_DATA;
    if (bundled && Object.prototype.hasOwnProperty.call(bundled, path)) {
      return Promise.resolve(bundled[path]);
    }
    if (bundled) return Promise.reject(new Error(path + ' はこのビルドに含まれていません'));
    return fetch(path, { cache: 'force-cache' }).then(function (r) {
      if (!r.ok) throw new Error(path + ' の読み込みに失敗しました (' + r.status + ')');
      return r.json();
    });
  }

  /* 画像 (海底地形図) を読む。バンドル版では data URI が埋め込まれている。 */
  function fetchImage(path) {
    var bundled = global.__BUNDLED_DATA;
    var src = bundled && Object.prototype.hasOwnProperty.call(bundled, path)
      ? bundled[path] : (bundled ? null : path);
    if (!src) return Promise.reject(new Error(path + ' はこのビルドに含まれていません'));
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error(path + ' の読み込みに失敗しました')); };
      img.src = src;
    });
  }

  App.load = function () {
    var self = this;
    return Promise.all([
      fetchJSON('data/stations.json'),
      fetchJSON('data/japan.geojson'),
      fetchJSON('data/regions.json'),
      fetchJSON('data/traveltime.json'),
      fetchJSON('data/tsunami_zones.json'),
      fetchJSON('data/landmask.json'),
      fetchJSON('data/subdivisions.json'),
      fetchJSON('data/scenarios/index.json').catch(function () { return { scenarios: [] }; })
    ]).then(function (res) {
      var stations = res[0], subdivisions = res[6];
      self.stations = stations;
      self.geo = res[1];
      self.landmask = new LandMask(res[5]);
      self.regions = new Regions(res[2], stations, self.landmask);
      self.tsunamiZones = res[4].zones;
      self.scenarioIndex = res[7].scenarios || [];

      self.engine = new global.Engine({
        stations: stations, traveltime: res[3], regions: self.regions,
        tsunamiZones: self.tsunamiZones, landmask: self.landmask
      });

      self.view.setGeo(self.geo);
      self.view.setStations(stations);
      // 海底地形図は無くても地図は成立するので、遅れて届いても構わない
      Promise.all([
        fetchImage('data/bathymetry.jpg'),
        fetchJSON('data/bathymetry.json')
      ]).then(function (r) {
        self.view.setRelief(r[0], r[1]);
        self.draw();
      }).catch(function () { /* 無ければ単色の海のまま */ });
      self.view.setTsunamiZones(self.tsunamiZones);
      self.view.setSubdivisions(subdivisions);

      // 観測点 -> 細分区域 の対応表
      var codeIndex = {};
      subdivisions.codes.forEach(function (c, i) { codeIndex[c] = i; });
      self.stationArea = new Int16Array(stations.count);
      for (var i = 0; i < stations.count; i++) {
        var c = stations.subarea[i];
        self.stationArea[i] = c && codeIndex[c] != null ? codeIndex[c] : -1;
      }
      self.subNames = subdivisions.names;
      self.scratch = new Float32Array(stations.count);
    });
  };

  /* ---------------- 再生対象 ---------------- */
  App.adoptScenario = function (payload) {
    var s = payload.stations, self = this;
    // 観測点を足したあとに計算し直していないシナリオは、値が 1 点ずつずれる
    if (this.stations && s.count !== this.stations.count) {
      throw new Error('シナリオの観測点数 (' + s.count + ') が今の観測点網 (' +
                      this.stations.count + ') と合いません。計算し直してください。');
    }
    var rt = U.decodeInt8(s.realtime), fin = U.decodeInt8(s.final);
    var scale = s.scale || 10, nt = payload.timeline.count, ns = s.count;
    var dt = payload.timeline.dt;

    function decodeScaled(b64, div) {
      var a = U.decodeInt16(b64), o = new Float32Array(ns);
      for (var i = 0; i < ns; i++) o[i] = a[i] / div;
      return o;
    }
    var finals = new Float32Array(ns);
    for (var i = 0; i < ns; i++) finals[i] = fin[i] / scale;

    this.setCurrent({
      title: payload.meta.name,
      source: payload.source,
      originDate: new Date(payload.meta.originTime),
      nt: nt, dt: dt, ns: ns,
      getValues: function (k) {
        var out = self.scratch;
        for (var j = 0; j < ns; j++) out[j] = rt[j * nt + k] / scale;
        return out;
      },
      /* 時刻を指定して読む。刻みの間は線形に補間するので、
       * 時系列を間引いたデータでも表示は滑らかになる。 */
      valuesAt: function (t) {
        var x = t / dt;
        var k0 = Math.max(0, Math.min(Math.floor(x), nt - 1));
        var k1 = Math.min(k0 + 1, nt - 1);
        var w = x - k0;
        var out = self.scratch;
        for (var j = 0; j < ns; j++) {
          var a = rt[j * nt + k0], b = rt[j * nt + k1];
          out[j] = (a + (b - a) * w) / scale;
        }
        return out;
      },
      final: finals,
      tp: decodeScaled(s.tp, 10), ts: decodeScaled(s.ts, 10),
      rupture: payload.source.rupture,
      eew: payload.eew || [],
      aftershocks: payload.aftershocks || [],
      tsunami: payload.tsunami || null
    });
  };

  App.adoptEngineResult = function (res, title, originDate) {
    var ns = this.stations.count, nt = res.timeline.count, rt = res.realtime, self = this;
    var dt = res.timeline.dt;
    this.setCurrent({
      title: title, source: res.source, originDate: originDate || new Date(),
      nt: nt, dt: dt, ns: ns,
      getValues: function (k) {
        var out = self.scratch;
        for (var i = 0; i < ns; i++) out[i] = rt[i * nt + k];
        return out;
      },
      valuesAt: function (t) {
        var x = t / dt;
        var k0 = Math.max(0, Math.min(Math.floor(x), nt - 1));
        var k1 = Math.min(k0 + 1, nt - 1);
        var w = x - k0;
        var out = self.scratch;
        for (var i = 0; i < ns; i++) {
          var a = rt[i * nt + k0], b = rt[i * nt + k1];
          out[i] = a + (b - a) * w;
        }
        return out;
      },
      final: res.final, tp: res.tp, ts: res.ts, rupture: null,
      eew: res.eew, aftershocks: res.aftershocks, tsunami: res.tsunami
    });
  };

  App.setCurrent = function (cur) {
    this.current = cur;
    this.t = 0;
    this.firedReports = 0;
    this.firedTsunami = false;
    this.detectLevel = 0;
    this.saidAreas = [];
    this.saidPoints = [];
    this.infoStage = 0;
    this.followBoxes = true;
    this.boxSpan = 0;
    this.boxQuietAt = null;
    this.phase = 'detect';
    this._tween = null;
    if (this.sound) this.sound.cancelSpeech();

    this.areaIntensity = this.aggregateBySubdivision(cur.final);
    this.view._subStamp = (this.view._subStamp || 0) + 1;
    this.waveStations = this.pickWaveStations(cur);

    el('track').max = String(cur.nt - 1);
    el('track').value = '0';
    el('scenario-name').textContent = cur.title || '';

    P.hideEEW(); P.hideTsunami(); P.hideFinalInfo(); P.hideDetect();
    this.firedTsunami = false;
    this.updateLegends();
    el('wave-strip').classList.toggle('hidden', !this.panelOn.wave);

    this.pushHistory({
      region: cur.source.region, magnitude: cur.source.magnitude,
      depth: cur.source.depth, maxIntensity: cur.source.maxIntensity,
      time: cur.originDate, source: cur.source
    }, true);

    // 検知の演出のため、まず震源周辺に寄る
    this.detectView = this.viewFor(cur, 0.30);
    this.wideView = this.viewFor(cur, 1.0);
    this.applyView(this.detectView);
    this.renderMarks();
  };

  /* 震源の規模に応じた表示範囲。
   * 揺れが及ぶ範囲を余裕をもって収める広さと、検知の演出で寄る狭さの 2 段。 */
  App.viewFor = function (cur, scale) {
    var span = U.clamp(3.6 + (cur.source.magnitude - 5) * 1.7, 4.0, 12) * scale;
    return { lat: cur.source.lat, lon: cur.source.lon, span: Math.max(span, 0.6) };
  };

  App.applyView = function (v) {
    this.view.proj.fitBounds(v.lat - v.span, v.lon - v.span * 1.15,
                             v.lat + v.span, v.lon + v.span * 1.15);
    this.view.baseKey = '';
    this.view._subCache = null;
  };

  /* 表示範囲をなめらかに動かす */
  App.tweenView = function (to, seconds) {
    var p = this.view.proj;
    this._tween = {
      from: { lat: p.centerLat, lon: p.centerLon, zoom: p.zoom },
      to: to, elapsed: 0, dur: seconds
    };
  };

  /* ---------------- 検知した範囲への追従 ----------------
   * 囲みが出たらその範囲を映し、広がるあいだは追いかける。
   * 広がらなくなったら元のズームへ戻す。
   */
  var FOLLOW_PAD = 1.55;        // 囲みの外に取る余白
  var FOLLOW_GROW = 1.12;       // これだけ広がったら映し直す
  var FOLLOW_RETURN_S = 12;     // 広がらなくなってから戻すまで [シナリオ内の秒]
  var FOLLOW_MOVE_S = 1.6;      // 映し直すのにかける時間 [実時間の秒]
  var FOLLOW_GIVEUP_S = 40;     // どこも反応しないまま経ったら戻す [シナリオ内の秒]

  App.followDetection = function (boxes) {
    if (!this.followBoxes || !this.current || this.phase === 'final') return;

    if (!boxes.length) {
      // どこも反応しないまま時間が経ったら、寄ったままにせず元のズームへ戻す
      this.boxSpan = 0;
      if (this.t > FOLLOW_GIVEUP_S) {
        this.followBoxes = false;
        this.tweenView(this.wideView, 2.0);
      }
      return;
    }

    var latMin = 1e9, latMax = -1e9, lonMin = 1e9, lonMax = -1e9;
    for (var i = 0; i < boxes.length; i++) {
      var b = boxes[i];
      if (b.latMin < latMin) latMin = b.latMin;
      if (b.latMax > latMax) latMax = b.latMax;
      if (b.lonMin < lonMin) lonMin = b.lonMin;
      if (b.lonMax > lonMax) lonMax = b.lonMax;
    }
    var span = Math.max((latMax - latMin) / 2, (lonMax - lonMin) / 2 / 1.15) * FOLLOW_PAD;
    span = U.clamp(span, 0.7, this.wideView.span);

    if (span > (this.boxSpan || 0) * FOLLOW_GROW || !this.boxSpan) {
      // 広がったので映し直す
      this.boxSpan = span;
      this.boxQuietAt = this.t;
      this.tweenView({ lat: (latMin + latMax) / 2, lon: (lonMin + lonMax) / 2, span: span },
                     FOLLOW_MOVE_S);
      return;
    }
    // しばらく広がっていなければ元のズームへ戻す
    if (this.boxQuietAt != null && this.t - this.boxQuietAt > FOLLOW_RETURN_S) {
      this.followBoxes = false;
      this.tweenView(this.wideView, 2.0);
    }
  };

  App.stepTween = function (dt) {
    var tw = this._tween;
    if (!tw) return;
    tw.elapsed += dt;
    var u = Math.min(tw.elapsed / tw.dur, 1);
    var e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;   // ease in-out

    if (!tw.target) {
      // 目標の中心とズームを一度だけ求める
      var p = this.view.proj;
      var save = { lat: p.centerLat, lon: p.centerLon, zoom: p.zoom };
      this.applyView(tw.to);
      tw.target = { lat: p.centerLat, lon: p.centerLon, zoom: p.zoom };
      p.centerLat = save.lat; p.centerLon = save.lon; p.zoom = save.zoom;
    }
    var pr = this.view.proj;
    pr.centerLat = tw.from.lat + (tw.target.lat - tw.from.lat) * e;
    pr.centerLon = tw.from.lon + (tw.target.lon - tw.from.lon) * e;
    pr.zoom = Math.exp(Math.log(tw.from.zoom) +
                       (Math.log(tw.target.zoom) - Math.log(tw.from.zoom)) * e);
    this.view.baseKey = '';
    this.view._subCache = null;
    if (u >= 1) this._tween = null;
  };

  /* ---------------- 集計 ---------------- */
  App.aggregateBySubdivision = function (values) {
    var idx = this.stationArea;
    var n = this.view.subCodes ? this.view.subCodes.length : 0;
    var out = new Float32Array(n);
    out.fill(-3);
    for (var i = 0; i < values.length; i++) {
      var a = idx[i];
      if (a < 0) continue;
      if (values[i] > out[a]) out[a] = values[i];
    }
    return out;
  };

  App.topAreas = function (areaIntensity, limit) {
    var out = [];
    for (var i = 0; i < areaIntensity.length; i++) {
      if (areaIntensity[i] >= 0.5) out.push({ name: this.subNames[i], intensity: areaIntensity[i] });
    }
    out.sort(function (a, b) { return b.intensity - a.intensity; });
    return out.slice(0, limit || 8);
  };

  App.pickWaveStations = function (cur) {
    var st = this.stations, n = st.lat.length, order = [];
    for (var i = 0; i < n; i++) {
      order.push([i, U.haversine(cur.source.lat, cur.source.lon, st.lat[i], st.lon[i])]);
    }
    order.sort(function (a, b) { return a[1] - b[1]; });
    var picks = [];
    for (var k = 0; k < 8; k++) {
      var j = Math.min(Math.floor(Math.pow(k / 7, 2) * (order.length - 1)), order.length - 1);
      picks.push(order[j][0]);
    }
    return picks;
  };

  /* 揺れを検出している観測点の範囲 */
  /* ---------------- 揺れている範囲の囲み ----------------
   * 反応した観測点を細分区域ごとにまとめ、区域ごとに矩形で囲む。
   * 揺れが広がるにつれて囲みが増えていき、強くなった区域は黄に変わる。
   */
  var BOX_REACT_GAL = 0.2;    // これを超えた観測点を「反応した」とみなす
  var BOX_STRONG_GAL = 2.0;   // これを超える区域は黄、それ以下は緑
  var BOX_MAX_STRONG = 16;    // 黄の上限
  var BOX_MAX_WEAK = 10;      // 緑の上限 (強い区域だけで埋まらないよう別枠にする)
  var BOX_MIN_POINTS = 2;     // 1 点だけの反応では囲まない

  App.detectionBoxes = function (values) {
    var st = this.stations, area = this.stationArea;
    var found = {}, keys = [];
    for (var i = 0; i < values.length; i++) {
      var gal = U.pgaFromIntensity(values[i]);
      if (gal < BOX_REACT_GAL) continue;
      var a = area[i];
      if (a < 0) continue;
      var box = found[a];
      if (!box) {
        box = found[a] = {
          latMin: st.lat[i], latMax: st.lat[i],
          lonMin: st.lon[i], lonMax: st.lon[i], gal: gal, n: 1
        };
        keys.push(a);
        continue;
      }
      box.n++;
      if (gal > box.gal) box.gal = gal;
      if (st.lat[i] < box.latMin) box.latMin = st.lat[i];
      if (st.lat[i] > box.latMax) box.latMax = st.lat[i];
      if (st.lon[i] < box.lonMin) box.lonMin = st.lon[i];
      if (st.lon[i] > box.lonMax) box.lonMax = st.lon[i];
    }

    var out = [];
    for (var k = 0; k < keys.length; k++) {
      var b = found[keys[k]];
      if (b.n < BOX_MIN_POINTS) continue;
      b.strong = b.gal >= BOX_STRONG_GAL;
      out.push(b);
    }
    // 揺れの強い区域から出す。緑と黄で別に上限を設け、
    // 強い区域だけで埋まって外側の弱い反応が消えないようにする。
    out.sort(function (x, y) { return y.gal - x.gal; });
    var strong = [], weak = [];
    for (var j = 0; j < out.length; j++) {
      if (out[j].strong) { if (strong.length < BOX_MAX_STRONG) strong.push(out[j]); }
      else if (weak.length < BOX_MAX_WEAK) weak.push(out[j]);
    }
    return strong.concat(weak);
  };

  /* ---------------- 履歴 ---------------- */
  App.pushHistory = function (entry, makeRecent) {
    this.history.unshift(entry);
    if (this.history.length > 60) this.history.pop();
    if (makeRecent) {
      this.recentResults.unshift(entry);
      if (this.recentResults.length > 5) this.recentResults.pop();
      this.activeRecent = 0;
    }
    this.refreshLists();
  };

  App.refreshLists = function () {
    var self = this;
    P.renderRecent(this.recentResults, this.activeRecent, function (i, q) { self.replay(i, q); });
    P.renderHistory(this.history);
  };

  App.replay = function (i, q) {
    this.activeRecent = i;
    var src = q.source;
    var res = this.engine.simulate({
      lat: src.lat, lon: src.lon, depth: src.depth, magnitude: src.magnitude,
      kind: src.kind || 'crustal', strike: src.strike || 0,
      dip: src.dip || 45, rake: src.rake == null ? 90 : src.rake
    }, { duration: 200, aftershocks: false, seed: 4321 });
    this.adoptEngineResult(res, q.region + ' ' + U.formatMagnitude(q.magnitude), q.time);
    this.play(true);
  };

  /* ---------------- 再生制御 ---------------- */
  App.play = function (on) {
    this.playing = on == null ? !this.playing : on;
    el('play-btn').textContent = this.playing ? '❚❚' : '▶';
    if (this.playing) {
      this.sound.unlock();
      if (!this.sound.slotsReady) this.sound.loadSlots();
      this.sound.loadVoice();
    }
    this.lastFrame = performance.now();
  };

  App.seek = function (k) {
    if (!this.current) return;
    var cur = this.current;
    this.t = k * cur.dt;
    this._tween = null;

    this.firedReports = 0;
    for (var i = 0; i < cur.eew.length; i++) if (cur.eew[i].issuedAt <= this.t) this.firedReports = i + 1;

    // 巻き戻し・早送りで鳴り直さないよう、今の反応の段まで進めておく
    var levels = this.sound.detectLevels();
    var gal = U.pgaFromIntensity(this.peakIntensity());
    this.saidAreas = [];
    this.saidPoints = [];
    this.detectLevel = 0;
    while (this.detectLevel < levels.length && gal >= levels[this.detectLevel]) this.detectLevel++;

    var first = cur.eew.length ? cur.eew[0].issuedAt : 6;
    var atEnd = k >= cur.nt - 1;
    this.phase = atEnd ? 'final' : (this.t < first ? 'detect' : 'monitor');

    this.boxSpan = 0;
    this.boxQuietAt = null;

    // 巻き戻し・早送りで鳴り直さないよう、今の時刻の段階まで進めておく
    this.infoStage = 0;
    while (this.infoStage < INFO_TIMES.length && this.t >= INFO_TIMES[this.infoStage]) this.infoStage++;

    if (this.phase === 'final') {
      this.showFinal();
    } else if (this.infoStage > 0) {
      this.showInfo(this.infoStage);
      el('wave-strip').classList.toggle('hidden', !this.panelOn.wave);
      if (this.firedReports > 0) P.showEEW(cur.eew[this.firedReports - 1], cur.originDate);
      else P.hideEEW();
    } else {
      P.hideFinalInfo();
      el('wave-strip').classList.toggle('hidden', !this.panelOn.wave);
      if (this.firedReports > 0) P.showEEW(cur.eew[this.firedReports - 1], cur.originDate);
      else P.hideEEW();
    }
    this.firedTsunami = !!(cur.tsunami && this.t >= cur.tsunami.issuedAt);
    if (this.firedTsunami && this.panelOn.tsunami) P.showTsunami(cur.tsunami, cur.originDate);
    else P.hideTsunami();
    this.updateLegends();
  };

  App.renderMarks = function () {
    var wrap = el('track-marks');
    wrap.innerHTML = '';
    if (!this.current) return;
    var total = (this.current.nt - 1) * this.current.dt;
    (this.current.eew || []).forEach(function (r) {
      var i = document.createElement('i');
      i.style.left = (100 * r.issuedAt / total) + '%';
      i.title = '第' + r.number + '報';
      wrap.appendChild(i);
    });
    if (this.current.tsunami) {
      var m = document.createElement('i');
      m.className = 'tsunami';
      m.style.left = (100 * this.current.tsunami.issuedAt / total) + '%';
      wrap.appendChild(m);
    }
  };

  /* ---------------- 毎フレーム ---------------- */
  App.tick = function (now) {
    var dtReal = Math.min((now - this.lastFrame) / 1000, 0.25);
    this.lastFrame = now;
    this.stepTween(dtReal);

    if (this.playing && this.current) {
      this.t += dtReal * this.speed;
      var total = (this.current.nt - 1) * this.current.dt;
      if (this.t >= total) {
        this.t = total;
        this.playing = false;
        el('play-btn').textContent = '▶';
        this.onPlaybackEnd();
      }
      el('track').value = String(Math.round(this.t / this.current.dt));
      this.processEvents();
    }
    this.draw();
    var self = this;
    requestAnimationFrame(function (ts) { self.tick(ts); });
  };

  /* 続報のうち「大きく変わった」ものを見分ける */
  function isMajorUpdate(prev, r) {
    return prev.kind !== r.kind
        || prev.maxShindo !== r.maxShindo
        || Math.abs(prev.magnitude - r.magnitude) >= 0.5
        || U.haversine(prev.lat, prev.lon, r.lat, r.lon) >= 30;
  }

  /* 今の時刻での全観測点の最大リアルタイム震度 */
  App.peakIntensity = function () {
    var cur = this.current;
    if (!cur) return -3;
    var vals = cur.valuesAt(this.t), mx = -3;
    for (var i = 0; i < vals.length; i++) if (vals[i] > mx) mx = vals[i];
    return mx;
  };

  /* 揺れを検出した地域の読み上げ。
   *
   * 最初に反応したところを一度だけ読み、そのあとは離れた地域 (別の地方) で
   * 反応が出たときにまた読む。近くの区域が次々に反応するたびには読まない。 */
  var DETECT_SAY_MIN = -0.5;        // 微弱の検知と同じくらいの反応から
  var DETECT_SAY_FAR_KM = 250.0;    // これだけ離れていれば別の地域として読み直す

  App.announceDetected = function (live) {
    if (!this.view.subCentroids || !this.subNames) return;
    var seen = this.saidAreas || (this.saidAreas = []);
    var said = this.saidPoints || (this.saidPoints = []);
    var best = -1, bv = DETECT_SAY_MIN;
    for (var a = 0; a < live.length; a++) {
      if (live[a] >= bv && seen.indexOf(a) < 0) { bv = live[a]; best = a; }
    }
    if (best < 0) return;
    var c = this.view.subCentroids[best];
    for (var i = 0; i < seen.length; i++) {
      // 既に反応している区域の近くなら、揺れが広がってきただけなので読まない。
      // 離れたところで同時に反応したときだけ読み直す。
      var d = this.view.subCentroids[seen[i]];
      if (U.haversine(c[0], c[1], d[0], d[1]) < DETECT_SAY_FAR_KM) {
        seen.push(best);
        return;
      }
    }
    seen.push(best);
    said.push(c);
    this.sound.announceDetect(this.subNames[best]);
  };

  App.processEvents = function () {
    var cur = this.current, eew = cur.eew || [];

    while (this.firedReports < eew.length && eew[this.firedReports].issuedAt <= this.t) {
      var r = eew[this.firedReports];
      if (this.firedReports === 0) {
        // 検知の演出から緊急地震速報の画面へ移る
        this.phase = 'monitor';
        if (r.kind === '警報') this.sound.warning(); else this.sound.forecast();
        this.sound.announceEEW(r);
      } else {
        // 続報は音だけ。読み上げは第 1 報の一度きり。
        var prev = eew[this.firedReports - 1];
        this.sound.update(prev ? isMajorUpdate(prev, r) : false);
      }
      P.showEEW(r, cur.originDate);
      this.firedReports++;
    }

    // 観測点の反応。揺れの最大 PGA が段を越えるたびに一度ずつ鳴らす。
    var levels = this.sound.detectLevels();
    if (this.detectLevel < levels.length) {
      var gal = U.pgaFromIntensity(this.peakIntensity());
      var reached = this.detectLevel;
      while (reached < levels.length && gal >= levels[reached]) reached++;
      // 一度に何段も上がったときは、いちばん上だけを鳴らす
      if (reached > this.detectLevel) {
        this.sound.detect(reached - 1);
        this.detectLevel = reached;
      }
    }

    // 地震情報。震度速報から順に、時間が来たものを出す。
    while (this.infoStage < INFO_TIMES.length && this.t >= INFO_TIMES[this.infoStage]) {
      this.infoStage++;
      this.showInfo(this.infoStage);
      this.sound.info(this.infoStage);
      this.announceInfo(this.infoStage);
    }

    if (cur.tsunami && !this.firedTsunami && this.t >= cur.tsunami.issuedAt) {
      this.firedTsunami = true;
      if (this.panelOn.tsunami) P.showTsunami(cur.tsunami, cur.originDate);
      this.updateLegends();
      this.sound.tsunami(cur.tsunami.maxLevel);
      this.sound.announceTsunami(cur.tsunami, cur.source);
    }
  };

  App.onPlaybackEnd = function () {
    var cur = this.current;
    if (!cur) return;
    this.phase = 'final';
    var wasFinal = this.infoStage >= 3;
    this.showFinal();
    if (!wasFinal) {
      this.sound.info(3);
      this.announceInfo(3);
    }
    // 余震は、この再生が終わってから次に進める (重ならないように)
    this.collectAftershocks();
    if (this.aftershockQueue) {
      this.queueNextAftershock(
        this.aftershockQueue.index === 0 ? AFTERSHOCK_FIRST_WAIT : AFTERSHOCK_GAP);
    }
  };

  /* 地震情報の発表時刻 [s]。気象庁の順序に合わせ、
   * 震度速報 -> 震源に関する情報 -> 震源・震度に関する情報 と出す。 */
  var INFO_TIMES = [90, 170, 260];

  /* 段階に応じた地震情報を読み上げる。
   *   1 震度速報       地震速報。最大震度○を。○○○。で観測しました。
   *   2 震源に関する情報 / 3 確定
   *     地震情報。午後○時○分頃、最大震度○を観測する地震がありました。… */
  App.announceInfo = function (stage) {
    var cur = this.current;
    if (!cur) return;
    if (stage <= 1) {
      var top = this.topAreas(this.areaIntensity, 1)[0];
      if (!top) return;
      this.sound.announceFlash({ shindo: U.shindoClass(top.intensity), area: top.name });
      return;
    }
    this.sound.announceQuake({
      time: cur.originDate,
      shindo: U.shindoClass(cur.source.maxIntensity),
      region: cur.source.region,
      depth: cur.source.depth,
      magnitude: cur.source.magnitude,
      tsunami: !!cur.tsunami
    });
  };

  /* 段階に応じた地震情報を出す (3 = 確定) */
  App.showInfo = function (stage) {
    var cur = this.current;
    if (!cur) return;
    P.showFinalInfo({
      stage: stage,
      region: cur.source.region, magnitude: cur.source.magnitude,
      depth: cur.source.depth, maxIntensity: cur.source.maxIntensity,
      time: cur.originDate, areas: this.topAreas(this.areaIntensity, 8)
    });
  };

  /* 凡例の出し分け。津波の沿岸線モードのときは、表示の切り替えが要るので
   * こちらの凡例を出したままにする。 */
  App.updateLegends = function () {
    var coastMode = this.view && this.view.stationStyle === 'coast';
    var showCoast = this.firedTsunami && !coastMode;
    el('coast-legend').classList.toggle('hidden', !showCoast);
    el('legend').classList.toggle('hidden', showCoast);
  };

  App.showFinal = function () {
    P.hideEEW();
    P.hideDetect();
    el('wave-strip').classList.add('hidden');
    this.infoStage = 3;
    this.showInfo(3);
  };

  /* ---------------- 余震の再生 ----------------
   * 一定間隔で次を始めると、前の余震の再生が終わらないうちに上書きされる。
   * 再生が終わってから次に進める。
   */
  var AFTERSHOCK_MIN_INTENSITY = 2.5;   // 震度 3 以上のものだけ再生する
  var AFTERSHOCK_MAX = 5;
  var AFTERSHOCK_FIRST_WAIT = 9000;
  var AFTERSHOCK_GAP = 6000;

  /* 本震の再生が終わったところで、再生する余震の列を作る */
  App.collectAftershocks = function () {
    var cur = this.current;
    if (this.aftershockQueue) return;              // 余震の再生中は作り直さない
    if (!cur.aftershocks || !cur.aftershocks.length) return;
    var notable = cur.aftershocks
      .filter(function (a) { return a.maxIntensity >= AFTERSHOCK_MIN_INTENSITY; })
      .slice(0, AFTERSHOCK_MAX);
    if (!notable.length) return;
    this.aftershockQueue = {
      list: notable, index: 0,
      origin: cur.originDate, kind: cur.source.kind
    };
    P.toast('余震活動を再生します（' + notable.length + '回）');
  };

  App.queueNextAftershock = function (delay) {
    var self = this;
    if (this._aftershockTimer) clearTimeout(this._aftershockTimer);
    this._aftershockTimer = setTimeout(function () { self.playNextAftershock(); }, delay);
  };

  App.playNextAftershock = function () {
    var q = this.aftershockQueue;
    if (!q || this._abortAftershocks) { this.aftershockQueue = null; return; }
    if (q.index >= q.list.length) { this.aftershockQueue = null; return; }
    var a = q.list[q.index++];
    var res = this.engine.simulate({
      lat: a.lat, lon: a.lon, depth: a.depth, magnitude: a.magnitude,
      kind: q.kind, strike: 0, dip: 45, rake: 90
    }, { duration: 120, aftershocks: false, tsunami: false, seed: 900 + q.index });
    this.adoptEngineResult(res, '余震 ' + a.region + ' ' + U.formatMagnitude(a.magnitude),
                           new Date(q.origin.getTime() + a.time * 1000));
    this.play(true);
  };

  App.cancelAftershocks = function () {
    this._abortAftershocks = true;
    this.aftershockQueue = null;
    if (this._aftershockTimer) clearTimeout(this._aftershockTimer);
    this._aftershockTimer = null;
  };

  /* ---------------- 描画 ---------------- */
  App.draw = function () {
    var v = this.view, cur = this.current;
    v.clear();

    if (cur) {
      var k = U.clamp(Math.round(this.t / cur.dt), 0, cur.nt - 1);
      // 観測点の色は強震モニタと同じで 1 秒ごとに切り替える
      var vals = cur.valuesAt(Math.floor(this.t));

      if (v.stationStyle === 'coast') {
        // 津波の沿岸線だけを出す
        v.drawCoastOnly(cur.tsunami, this.t, this.firedTsunami);
      } else if (this.phase === 'final') {
        v.drawObservedSubdivisions(this.areaIntensity);
        v.drawStationShindo(cur.final);
        v.drawSubdivisionTiles(this.areaIntensity);
        if (cur.tsunami && this.firedTsunami) v.drawTsunami(cur.tsunami, this.t);
      } else {
        if (cur.tsunami && this.firedTsunami) v.drawTsunami(cur.tsunami, this.t);
        if (this.t > 0) {
          v.drawWavefronts(cur.source.lat, cur.source.lon,
                           this.waveRadius('P', cur.source.depth, this.t),
                           this.waveRadius('S', cur.source.depth, this.t));
        }
        if (cur.rupture) v.drawRupture(cur.rupture, this.t);
        // 表示の切り替え (色のみ / 震度つき) は凡例のスイッチに従う。
        // 検知の段階でも同じで、囲みの四角だけを足す。
        v.drawStations(vals);
        // 揺れている範囲の囲み。広がるあいだずっと出す。
        var boxes = this.detectionBoxes(vals);
        v.drawDetectionBoxes(boxes, this.t, this.phase === 'detect');
        this.followDetection(boxes);
      }

      v.drawEpicenter(cur.source.lat, cur.source.lon,
                      this.phase !== 'final' && this.t < 30 ? (this.t % 2) / 2 : 0);

      el('tl-elapsed').textContent = U.formatElapsed(this.t);
      if (this.panelOn.wave && this.phase !== 'final') this.drawWaveStrip(k);

      // 揺れを検出パネル (現在のリアルタイム震度)
      if (this.phase !== 'final') {
        var live = this.aggregateBySubdivision(vals);
        this.announceDetected(live);
        var mx = -3;
        for (var q = 0; q < vals.length; q++) if (vals[q] > mx) mx = vals[q];
        P.showDetect(mx, this.topAreas(live, 6));
      }
    } else if (v.stationStyle === 'coast') {
      v.drawCoastOnly(null, 0, false);
    } else {
      v.drawStations(null);
    }
    v.drawScaleBar();
    this.updateClock();
  };

  App.drawWaveStrip = function (k) {
    var cv = el('wave-canvas');
    if (!cv || !this.waveStations || !this.current) return;
    var rect = cv.getBoundingClientRect();
    if (rect.width < 2) return;
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    if (cv.width !== Math.round(rect.width * dpr)) {
      cv.width = Math.round(rect.width * dpr);
      cv.height = Math.round(rect.height * dpr);
    }
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var w = rect.width, h = rect.height;
    ctx.clearRect(0, 0, w, h);

    var cur = this.current, rows = this.waveStations.length, rowH = h / rows;
    var k0 = Math.max(0, k - 40), pts = k - k0 + 1;
    if (pts < 2) return;

    ctx.lineWidth = 1;
    for (var r = 0; r < rows; r++) {
      var idx = this.waveStations[r], yMid = rowH * (r + 0.5);
      ctx.strokeStyle = '#dcecff';
      ctx.beginPath();
      for (var j = 0; j <= k - k0; j++) {
        var kk = k0 + j;
        var inten = cur.getValues(kk)[idx];
        var amp = inten > -3 ? Math.pow(10, (inten - 0.94) / 2) : 0;
        var norm = Math.min(Math.log10(1 + amp) / 2.6, 1);
        var osc = Math.sin(kk * 12.9898 + idx * 78.233) * Math.sin(kk * 3.7 + r);
        var y = yMid - norm * (rowH * 0.46) * osc;
        var x = (j / (pts - 1)) * (w - 4) + 2;
        if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      if (r < rows - 1) {
        ctx.strokeStyle = 'rgba(255,255,255,.15)';
        ctx.beginPath();
        ctx.moveTo(0, rowH * (r + 1)); ctx.lineTo(w, rowH * (r + 1));
        ctx.stroke();
      }
    }
  };

  App.waveRadius = function (phase, depth, t) {
    if (t <= 0) return 0;
    var lo = 0, hi = 2200;
    for (var i = 0; i < 22; i++) {
      var mid = (lo + hi) / 2;
      if (this.engine.travelTime(phase, depth, mid) < t) lo = mid; else hi = mid;
    }
    return lo;
  };

  App.updateClock = function () {
    var base = this.current ? this.current.originDate : new Date();
    var d = this.current ? new Date(base.getTime() + this.t * 1000) : new Date();
    el('clock-text').textContent = U.formatDate(d) + ' ' + U.formatClock(d);
  };

  /* ---------------- 設定モード ---------------- */
  var DEFAULT_SOURCE = {
    lat: 33.10, lon: 136.20, depth: 20, magnitude: 8.6, kind: 'interplate',
    strike: 250, dip: 12, rake: 90
  };

  App.readConfig = function () {
    var timeStr = el('cfg-time').value, origin = new Date();
    if (timeStr) {
      var parts = timeStr.split(':');
      origin.setHours(+parts[0] || 0, +parts[1] || 0, +(parts[2] || 0), 0);
    }
    return {
      lat: parseFloat(el('cfg-lat').value), lon: parseFloat(el('cfg-lon').value),
      depth: parseFloat(el('cfg-depth').value), magnitude: parseFloat(el('cfg-mag').value),
      kind: el('cfg-kind').value, strike: parseFloat(el('cfg-strike').value),
      dip: parseFloat(el('cfg-dip').value), rake: parseFloat(el('cfg-rake').value),
      origin: origin,
      aftershocks: el('cfg-aftershock').checked,
      tsunami: el('cfg-tsunami').checked,
      eew: el('cfg-eew').checked,
      drill: el('cfg-drill').checked
    };
  };

  App.updateConfigPreview = function () {
    var c = this.readConfig();
    if (!isFinite(c.lat) || !isFinite(c.lon)) return;
    el('cfg-region').value = this.regions.nameAt(c.lat, c.lon);
    var dim = this.engine.faultDimensions(c.magnitude, c.kind, c.dip);
    var onLand = this.landmask.isLand(c.lat, c.lon);
    this._preview = { src: c, dim: dim };
    el('config-preview').innerHTML =
      '想定断層 ' + dim.length.toFixed(0) + ' x ' + dim.width.toFixed(0) + ' km' +
      '（面積 ' + dim.area.toFixed(0) + ' km²）<br>' +
      '震源域: ' + (onLand ? '陸域' : '海域') +
      ' / 津波: ' + (!onLand && c.depth <= 60 && c.magnitude >= 6.0 ? '発生の可能性あり' : 'なし');
  };

  App.runConfig = function () {
    var c = this.readConfig(), self = this;
    if (!isFinite(c.lat) || !isFinite(c.lon) || !isFinite(c.magnitude)) {
      P.toast('入力値を確認してください'); return;
    }
    P.toast('計算中…');
    setTimeout(function () {
      var res = self.engine.simulate(c, {
        duration: 260, aftershocks: c.aftershocks, tsunami: c.tsunami,
        eew: c.eew, aftershockDays: 3, seed: Date.now() & 0xffff
      });
      self.cancelAftershocks();
      self._abortAftershocks = false;
      self.setDrill(c.drill);
      self.adoptEngineResult(res, res.source.region + ' ' + U.formatMagnitude(c.magnitude), c.origin);
      self.setMode('visual');
      self.play(true);
    }, 30);
  };

  /* 設定モードの入力欄に震源を書き込む */
  App.fillConfigForm = function (src) {
    el('cfg-lat').value = src.lat.toFixed(2);
    el('cfg-lon').value = src.lon.toFixed(2);
    el('cfg-depth').value = String(src.depth);
    el('cfg-mag').value = src.magnitude.toFixed(1);
    el('cfg-kind').value = src.kind;
    el('cfg-strike').value = String(src.strike);
    el('cfg-dip').value = String(src.dip);
    el('cfg-rake').value = String(src.rake);
    this.updateConfigPreview();
  };

  App.loadScenario = function (entry) {
    var self = this;
    P.toast('シナリオを読み込み中…');
    fetchJSON('data/scenarios/' + entry.file).then(function (payload) {
      self.cancelAftershocks();
      self._abortAftershocks = false;
      self.adoptScenario(payload);
      self.setMode('visual');
      self.play(true);
    }).catch(function (e) { P.toast(e.message); });
  };

  App.renderScenarioList = function () {
    var ul = el('scenario-list'), self = this;
    ul.innerHTML = '';
    if (!this.scenarioIndex.length) {
      var li0 = document.createElement('li');
      li0.style.color = 'var(--text-faint)';
      li0.textContent = '計算済みシナリオはありません';
      ul.appendChild(li0);
      return;
    }
    this.scenarioIndex.forEach(function (s) {
      var li = document.createElement('li');
      var badge = document.createElement('div');
      badge.className = 'shindo-badge sm';
      P.setBadge(badge, s.maxIntensity);
      var main = document.createElement('div');
      main.className = 'sl-main';
      var n = document.createElement('div');
      n.className = 'sl-name'; n.textContent = s.name;
      var sub = document.createElement('div');
      sub.className = 'sl-sub';
      sub.textContent = U.formatMagnitude(s.magnitude) + ' / ' + Math.round(s.depth) + 'km / 最大震度' +
                        s.maxShindo + (s.tsunami ? ' / ' + s.tsunami : '');
      main.appendChild(n); main.appendChild(sub);
      li.appendChild(badge); li.appendChild(main);
      li.addEventListener('click', function () { self.loadScenario(s); });
      ul.appendChild(li);
    });
  };

  App.setDrill = function (on) {
    this.drill = !!on;
    el('drill-badge').classList.toggle('hidden', !this.drill);
  };

  App.setMode = function (mode) {
    this.mode = mode;
    el('mode-visual').classList.toggle('active', mode === 'visual');
    el('mode-config').classList.toggle('active', mode === 'config');
    el('mode-visual').setAttribute('aria-selected', String(mode === 'visual'));
    el('mode-config').setAttribute('aria-selected', String(mode === 'config'));
    el('config-panel').classList.toggle('hidden', mode !== 'config');
    el('rail-config').classList.toggle('active', mode === 'config');
    this.view.canvas.classList.toggle('picking', mode === 'config');
    if (mode === 'config') { this.updateConfigPreview(); this.renderScenarioList(); }
    else this._preview = null;
  };

  /* ---------------- 入力 ---------------- */
  App.bind = function () {
    var self = this, canvas = this.view.canvas;

    el('mode-visual').addEventListener('click', function () { self.setMode('visual'); });
    el('mode-config').addEventListener('click', function () { self.setMode('config'); });
    el('rail-config').addEventListener('click', function () {
      self.setMode(self.mode === 'config' ? 'visual' : 'config');
    });

    el('play-btn').addEventListener('click', function () { self.play(); });
    el('reset-btn').addEventListener('click', function () {
      self.seek(0); el('track').value = '0'; self.play(false);
    });
    el('track').addEventListener('input', function () { self.seek(+this.value); });
    el('speed').addEventListener('change', function () { self.speed = parseFloat(this.value); });
    el('sound-toggle').addEventListener('change', function () { self.sound.setEnabled(this.checked); });

    el('tab-current').addEventListener('click', function () {
      el('tab-current').classList.add('active'); el('tab-history').classList.remove('active');
      el('pane-current').classList.remove('hidden'); el('pane-history').classList.add('hidden');
    });
    el('tab-history').addEventListener('click', function () {
      el('tab-history').classList.add('active'); el('tab-current').classList.remove('active');
      el('pane-history').classList.remove('hidden'); el('pane-current').classList.add('hidden');
    });

    ['cfg-lat', 'cfg-lon', 'cfg-depth', 'cfg-mag', 'cfg-kind', 'cfg-strike', 'cfg-dip', 'cfg-rake']
      .forEach(function (id) {
        el(id).addEventListener('input', function () { self.updateConfigPreview(); });
        el(id).addEventListener('change', function () { self.updateConfigPreview(); });
      });
    el('cfg-run').addEventListener('click', function () { self.runConfig(); });
    el('cfg-random').addEventListener('click', function () { self.randomize(); });
    el('cfg-drill').addEventListener('change', function () { self.setDrill(this.checked); });

    el('rail-info').addEventListener('click', function () {
      self.panelOn.info = !self.panelOn.info;
      this.classList.toggle('active', self.panelOn.info);
      el('info-panel').classList.toggle('hidden', !self.panelOn.info);
    });
    el('rail-wave').addEventListener('click', function () {
      self.panelOn.wave = !self.panelOn.wave;
      this.classList.toggle('active', self.panelOn.wave);
      el('wave-strip').classList.toggle('hidden', !self.panelOn.wave || self.phase === 'final');
    });
    el('rail-tsunami').addEventListener('click', function () {
      self.panelOn.tsunami = !self.panelOn.tsunami;
      this.classList.toggle('active', self.panelOn.tsunami);
      if (!self.panelOn.tsunami) P.hideTsunami();
      else if (self.firedTsunami && self.current) P.showTsunami(self.current.tsunami, self.current.originDate);
    });

    function setStationStyle(style) {
      self.view.stationStyle = style;
      P.setLegendStyle(style);
      self.updateLegends();
      try { localStorage.setItem('stationStyle', style); } catch (e) { /* 保存できなくても続行 */ }
      self.draw();  // 停止中に切り替えても反映されるように
    }
    el('style-number').addEventListener('click', function () { setStationStyle('number'); });
    el('style-color').addEventListener('click', function () { setStationStyle('color'); });
    el('style-coast').addEventListener('click', function () { setStationStyle('coast'); });
    var saved = null;
    try { saved = localStorage.getItem('stationStyle'); } catch (e) { saved = null; }
    setStationStyle(saved === 'color' || saved === 'coast' ? saved : 'number');

    el('zoom-in').addEventListener('click', function () {
      self._tween = null;
      self.followBoxes = false;
      self.view.proj.zoomAt(1.4, self.view.cssWidth / 2, self.view.cssHeight / 2);
      self.view.baseKey = ''; self.view._subCache = null;
    });
    el('zoom-out').addEventListener('click', function () {
      self._tween = null;
      self.followBoxes = false;
      self.view.proj.zoomAt(1 / 1.4, self.view.cssWidth / 2, self.view.cssHeight / 2);
      self.view.baseKey = ''; self.view._subCache = null;
    });
    el('zoom-fit').addEventListener('click', function () {
      self._tween = null;
      self.followBoxes = false;
      if (self.current) self.applyView(self.wideView);
      else { self.view.proj.fitBounds(30.0, 128.0, 45.5, 146.0); self.view.baseKey = ''; }
      self.view._subCache = null;
    });

    var dragging = false, lastX = 0, lastY = 0, moved = 0;
    canvas.addEventListener('pointerdown', function (e) {
      dragging = true; moved = 0; lastX = e.clientX; lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
      canvas.classList.add('dragging');
      self._tween = null;
      self.followBoxes = false;
      self.sound.unlock();
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - lastX, dy = e.clientY - lastY;
      moved += Math.abs(dx) + Math.abs(dy);
      lastX = e.clientX; lastY = e.clientY;
      self.view.proj.panByPixels(dx, dy);
      self.view.baseKey = ''; self.view._subCache = null;
    });
    canvas.addEventListener('pointerup', function (e) {
      dragging = false;
      canvas.classList.remove('dragging');
      if (moved < 4 && self.mode === 'config') {
        var rect = canvas.getBoundingClientRect();
        var ll = self.view.proj.unproject(e.clientX - rect.left, e.clientY - rect.top);
        el('cfg-lat').value = ll[0].toFixed(2);
        el('cfg-lon').value = ll[1].toFixed(2);
        self.updateConfigPreview();
      }
    });
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      self._tween = null;
      self.followBoxes = false;
      var rect = canvas.getBoundingClientRect();
      self.view.proj.zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15,
                            e.clientX - rect.left, e.clientY - rect.top);
      self.view.baseKey = ''; self.view._subCache = null;
    }, { passive: false });

    // スマートフォンではパネルを下からのシートにしている。開閉できるようにする。
    var toggle = el('sheet-toggle');
    if (toggle) {
      toggle.addEventListener('click', function () {
        el('app').classList.toggle('sheet-collapsed');
        // 地図の高さが変わるので、遷移が終わってから測り直す
        setTimeout(function () { self.view.resize(); self.draw(); }, 240);
      });
    }

    global.addEventListener('resize', function () { self.view.resize(); });
    global.addEventListener('orientationchange', function () {
      setTimeout(function () { self.view.resize(); self.draw(); }, 250);
    });
    global.addEventListener('keydown', function (e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.code === 'Space') { e.preventDefault(); self.play(); }
      if (e.code === 'KeyR') { self.seek(0); el('track').value = '0'; }
    });
  };

  App.randomize = function () {
    var regions = this.regions.list.filter(function (r) { return r.type === 'sea' || r.stations > 4; });
    var r = regions[Math.floor(Math.random() * regions.length)];
    var mag = Math.round((5.5 + Math.random() * 3.2) * 10) / 10;
    var depth = Math.round(5 + Math.random() * 60);
    el('cfg-lat').value = (r.lat + (Math.random() - 0.5) * 0.4).toFixed(2);
    el('cfg-lon').value = (r.lon + (Math.random() - 0.5) * 0.4).toFixed(2);
    el('cfg-mag').value = mag.toFixed(1);
    el('cfg-depth').value = String(depth);
    el('cfg-kind').value = depth > 60 ? 'intraslab' : (r.type === 'sea' ? 'interplate' : 'crustal');
    this.updateConfigPreview();
  };

  /* ---------------- 起動 ---------------- */
  App.start = function () {
    this.view = new global.MapView(el('map'));
    this.sound = new global.Sound();
    P.drawLegend(this.view.stationStyle);

    var now = new Date();
    el('cfg-time').value = U.pad(now.getHours()) + ':' + U.pad(now.getMinutes()) + ':' + U.pad(now.getSeconds());

    var self = this;
    this.load().then(function () {
      el('loading').classList.add('hidden');
      self.bind();
      self.refreshLists();
      self.setDrill(true);
      self.view.proj.fitBounds(30.0, 128.0, 45.5, 146.0);
      self.setMode('visual');
      // 起動しただけでは地震を起こさない。観測点を見せて待つ。
      self.fillConfigForm(DEFAULT_SOURCE);
      P.toast('設定モードで震源を決めるか、保存済みシナリオを選んでください', 5200);
      self.lastFrame = performance.now();
      requestAnimationFrame(function (ts) { self.tick(ts); });
    }).catch(function (e) {
      el('loading').textContent = '読み込みエラー: ' + e.message;
      console.error(e);
    });
  };

  global.App = App;
  document.addEventListener('DOMContentLoaded', function () { App.start(); });
})(window);
