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
  function Regions(regionsJson, stations, landmask) {
    this.list = regionsJson.regions;
    this.byCode = {};
    this.seaLat = []; this.seaLon = []; this.seaRef = [];
    for (var i = 0; i < this.list.length; i++) {
      var r = this.list[i];
      this.byCode[r.code] = r;
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
      self.view.setTsunamiZones(self.tsunamiZones);
      self.view.setSubdivisions(subdivisions, self.landmask);

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
    var rt = U.decodeInt8(s.realtime), fin = U.decodeInt8(s.final);
    var scale = s.scale || 10, nt = payload.timeline.count, ns = s.count;

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
      nt: nt, dt: payload.timeline.dt, ns: ns,
      getValues: function (k) {
        var out = self.scratch;
        for (var j = 0; j < ns; j++) out[j] = rt[j * nt + k] / scale;
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
    this.setCurrent({
      title: title, source: res.source, originDate: originDate || new Date(),
      nt: nt, dt: res.timeline.dt, ns: ns,
      getValues: function (k) {
        var out = self.scratch;
        for (var i = 0; i < ns; i++) out[i] = rt[i * nt + k];
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
    el('coast-legend').classList.add('hidden');
    el('legend').classList.remove('hidden');
    el('wave-strip').classList.toggle('hidden', !this.panelOn.wave);

    this.pushHistory({
      region: cur.source.region, magnitude: cur.source.magnitude,
      depth: cur.source.depth, maxIntensity: cur.source.maxIntensity,
      time: cur.originDate, source: cur.source
    }, true);

    // 検知の演出のため、まず震源周辺に寄る
    this.detectView = this.viewFor(cur, 0.45);
    this.wideView = this.viewFor(cur, 1.0);
    this.applyView(this.detectView);
    this.renderMarks();
  };

  /* 震源の規模に応じた表示範囲 */
  App.viewFor = function (cur, scale) {
    var span = U.clamp(1.3 + (cur.source.magnitude - 5) * 0.95, 1.0, 9) * scale;
    return { lat: cur.source.lat, lon: cur.source.lon, span: Math.max(span, 0.5) };
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
  App.detectionBox = function (values) {
    var st = this.stations;
    var latMin = 1e9, latMax = -1e9, lonMin = 1e9, lonMax = -1e9, any = false;
    for (var i = 0; i < values.length; i++) {
      if (values[i] < -0.5) continue;
      any = true;
      if (st.lat[i] < latMin) latMin = st.lat[i];
      if (st.lat[i] > latMax) latMax = st.lat[i];
      if (st.lon[i] < lonMin) lonMin = st.lon[i];
      if (st.lon[i] > lonMax) lonMax = st.lon[i];
    }
    return any ? { latMin: latMin, latMax: latMax, lonMin: lonMin, lonMax: lonMax } : null;
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

    var first = cur.eew.length ? cur.eew[0].issuedAt : 6;
    var atEnd = k >= cur.nt - 1;
    this.phase = atEnd ? 'final' : (this.t < first ? 'detect' : 'monitor');

    if (this.phase === 'final') {
      this.showFinal();
    } else {
      P.hideFinalInfo();
      el('wave-strip').classList.toggle('hidden', !this.panelOn.wave);
      if (this.firedReports > 0) P.showEEW(cur.eew[this.firedReports - 1], cur.originDate);
      else P.hideEEW();
    }
    this.firedTsunami = !!(cur.tsunami && this.t >= cur.tsunami.issuedAt);
    if (this.firedTsunami && this.panelOn.tsunami) P.showTsunami(cur.tsunami, cur.originDate);
    else P.hideTsunami();
    el('coast-legend').classList.toggle('hidden', !this.firedTsunami);
    el('legend').classList.toggle('hidden', this.firedTsunami);
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

  App.processEvents = function () {
    var cur = this.current, eew = cur.eew || [];

    while (this.firedReports < eew.length && eew[this.firedReports].issuedAt <= this.t) {
      var r = eew[this.firedReports];
      if (this.firedReports === 0) {
        // 検知の演出から緊急地震速報の画面へ移る
        this.phase = 'monitor';
        this.tweenView(this.wideView, 1.4);
        if (r.kind === '警報') this.sound.warning(); else this.sound.forecast();
        this.sound.announceEEW(r);
      } else {
        this.sound.blip();
        var prev = eew[this.firedReports - 1];
        if (prev && (prev.kind !== r.kind || prev.maxShindo !== r.maxShindo)) this.sound.announceEEW(r);
      }
      P.showEEW(r, cur.originDate);
      this.firedReports++;
    }

    if (cur.tsunami && !this.firedTsunami && this.t >= cur.tsunami.issuedAt) {
      this.firedTsunami = true;
      if (this.panelOn.tsunami) P.showTsunami(cur.tsunami, cur.originDate);
      el('coast-legend').classList.remove('hidden');
      el('legend').classList.add('hidden');
      this.sound.tsunami(cur.tsunami.maxLevel);
      this.sound.announceTsunami(cur.tsunami);
    }
  };

  App.onPlaybackEnd = function () {
    var cur = this.current;
    if (!cur) return;
    this.phase = 'final';
    this.showFinal();
    this.sound.info();
    this.sound.announceQuake({
      region: cur.source.region, shindo: cur.source.maxShindo,
      magnitude: cur.source.magnitude, depth: cur.source.depth
    });
    this.scheduleAftershocks();
  };

  App.showFinal = function () {
    var cur = this.current;
    P.hideEEW();
    P.hideDetect();
    el('wave-strip').classList.add('hidden');
    P.showFinalInfo({
      region: cur.source.region, magnitude: cur.source.magnitude,
      depth: cur.source.depth, maxIntensity: cur.source.maxIntensity,
      time: cur.originDate, areas: this.topAreas(this.areaIntensity, 8)
    });
  };

  App.scheduleAftershocks = function () {
    var cur = this.current;
    if (!cur.aftershocks || !cur.aftershocks.length) return;
    var notable = cur.aftershocks.filter(function (a) { return a.maxIntensity >= 1.5; }).slice(0, 8);
    if (!notable.length) return;
    var self = this, i = 0;
    P.toast('余震活動を再生します（' + notable.length + '回）');
    function next() {
      if (i >= notable.length || self._abortAftershocks) return;
      var a = notable[i++];
      var when = new Date(cur.originDate.getTime() + a.time * 1000);
      var res = self.engine.simulate({
        lat: a.lat, lon: a.lon, depth: a.depth, magnitude: a.magnitude,
        kind: cur.source.kind, strike: 0, dip: 45, rake: 90
      }, { duration: 120, aftershocks: false, tsunami: false, seed: 900 + i });
      self.adoptEngineResult(res, '余震 ' + a.region + ' ' + U.formatMagnitude(a.magnitude), when);
      self.play(true);
      setTimeout(next, 11000);
    }
    setTimeout(next, 9000);
  };

  /* ---------------- 描画 ---------------- */
  App.draw = function () {
    var v = this.view, cur = this.current;
    v.clear();

    if (cur) {
      var k = U.clamp(Math.round(this.t / cur.dt), 0, cur.nt - 1);
      var vals = cur.getValues(k);

      if (this.phase === 'final') {
        v.drawObservedSubdivisions(this.areaIntensity);
        v.drawStationDots(cur.final);
        v.drawSubdivisionBadges(this.areaIntensity);
        if (cur.tsunami && this.firedTsunami) v.drawTsunami(cur.tsunami, this.t);
      } else {
        if (cur.tsunami && this.firedTsunami) v.drawTsunami(cur.tsunami, this.t);
        if (this.t > 0) {
          v.drawWavefronts(cur.source.lat, cur.source.lon,
                           this.waveRadius('P', cur.source.depth, this.t),
                           this.waveRadius('S', cur.source.depth, this.t));
        }
        if (cur.rupture) v.drawRupture(cur.rupture, this.t);
        if (this.phase === 'detect') {
          // 検知の段階は震度の数字を出さず、色の反応だけを見せる
          var saved = v.stationStyle;
          v.stationStyle = 'color';
          v.drawStations(vals);
          v.stationStyle = saved;
          v.drawDetectionBox(this.detectionBox(vals), this.t);
        } else {
          v.drawStations(vals);
        }
      }

      v.drawEpicenter(cur.source.lat, cur.source.lon,
                      this.phase !== 'final' && this.t < 30 ? (this.t % 2) / 2 : 0);

      el('tl-elapsed').textContent = U.formatElapsed(this.t);
      if (this.panelOn.wave && this.phase !== 'final') this.drawWaveStrip(k);

      // 揺れを検出パネル (現在のリアルタイム震度)
      if (this.phase !== 'final') {
        var live = this.aggregateBySubdivision(vals);
        var mx = -3;
        for (var q = 0; q < vals.length; q++) if (vals[q] > mx) mx = vals[q];
        P.showDetect(mx, this.topAreas(live, 6));
      }
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
      self._abortAftershocks = false;
      self.setDrill(c.drill);
      self.adoptEngineResult(res, res.source.region + ' ' + U.formatMagnitude(c.magnitude), c.origin);
      self.setMode('visual');
      self.play(true);
    }, 30);
  };

  App.runDefault = function () {
    var res = this.engine.simulate(DEFAULT_SOURCE, {
      duration: 260, aftershocks: true, tsunami: true, eew: true,
      aftershockDays: 3, seed: 20260101
    });
    this.adoptEngineResult(res, res.source.region + ' ' + U.formatMagnitude(DEFAULT_SOURCE.magnitude), new Date());
    this.play(true);
    el('cfg-lat').value = DEFAULT_SOURCE.lat.toFixed(2);
    el('cfg-lon').value = DEFAULT_SOURCE.lon.toFixed(2);
    el('cfg-depth').value = String(DEFAULT_SOURCE.depth);
    el('cfg-mag').value = DEFAULT_SOURCE.magnitude.toFixed(1);
    el('cfg-kind').value = DEFAULT_SOURCE.kind;
    el('cfg-strike').value = String(DEFAULT_SOURCE.strike);
    el('cfg-dip').value = String(DEFAULT_SOURCE.dip);
    el('cfg-rake').value = String(DEFAULT_SOURCE.rake);
  };

  App.loadScenario = function (entry) {
    var self = this;
    P.toast('シナリオを読み込み中…');
    fetchJSON('data/scenarios/' + entry.file).then(function (payload) {
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
      try { localStorage.setItem('stationStyle', style); } catch (e) { /* 保存できなくても続行 */ }
    }
    el('style-number').addEventListener('click', function () { setStationStyle('number'); });
    el('style-color').addEventListener('click', function () { setStationStyle('color'); });
    var saved = null;
    try { saved = localStorage.getItem('stationStyle'); } catch (e) { saved = null; }
    setStationStyle(saved === 'color' ? 'color' : 'number');

    el('zoom-in').addEventListener('click', function () {
      self._tween = null;
      self.view.proj.zoomAt(1.4, self.view.cssWidth / 2, self.view.cssHeight / 2);
      self.view.baseKey = ''; self.view._subCache = null;
    });
    el('zoom-out').addEventListener('click', function () {
      self._tween = null;
      self.view.proj.zoomAt(1 / 1.4, self.view.cssWidth / 2, self.view.cssHeight / 2);
      self.view.baseKey = ''; self.view._subCache = null;
    });
    el('zoom-fit').addEventListener('click', function () {
      self._tween = null;
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
      var rect = canvas.getBoundingClientRect();
      self.view.proj.zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15,
                            e.clientX - rect.left, e.clientY - rect.top);
      self.view.baseKey = ''; self.view._subCache = null;
    }, { passive: false });

    global.addEventListener('resize', function () { self.view.resize(); });
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
    P.drawLegend();

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
      if (self.scenarioIndex.length) self.loadScenario(self.scenarioIndex[0]);
      else self.runDefault();
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
