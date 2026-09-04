/* 全体制御: データ読み込み・モード切替・再生・描画ループ */
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
  /* 2 点間の経路が陸域に遮られているか (沿岸手前 15 km は判定しない) */
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
    phase: 'monitor',          // 'monitor' = 揺れの最中 / 'final' = 確定震度の表示
    playing: false,
    t: 0,
    speed: 1,
    current: null,
    history: [],
    recentResults: [],
    activeRecent: 0,
    aftershockQueue: [],
    lastFrame: 0,
    firedReports: 0,
    firedTsunami: false,
    panelOn: { info: true, eew: true, tsunami: true, wave: true, sound: true }
  };

  /* ---------------- 読み込み ---------------- */
  function fetchJSON(path) {
    // 単一 HTML にまとめたビルドでは、埋め込んだデータをそのまま返す
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
      fetchJSON('data/scenarios/index.json').catch(function () { return { scenarios: [] }; })
    ]).then(function (res) {
      var stations = res[0];
      self.stations = stations;
      self.geo = res[1];
      self.landmask = new LandMask(res[5]);
      self.regions = new Regions(res[2], stations, self.landmask);
      self.tsunamiZones = res[4].zones;
      self.scenarioIndex = res[6].scenarios || [];

      self.engine = new global.Engine({
        stations: stations,
        traveltime: res[3],
        regions: self.regions,
        tsunamiZones: self.tsunamiZones,
        landmask: self.landmask
      });

      self.view.setGeo(self.geo);
      self.view.setStations(stations);
      self.view.setTsunamiZones(self.tsunamiZones);
      self.scratch = new Float32Array(stations.lat.length);
    });
  };

  /* ---------------- 再生対象の設定 ---------------- */
  /* Python 側のシナリオ JSON を再生用の形に整える */
  App.adoptScenario = function (payload) {
    var s = payload.stations;
    var rt = U.decodeInt8(s.realtime);
    var fin = U.decodeInt8(s.final);
    var scale = s.scale || 10;
    var nt = payload.timeline.count;
    var ns = s.count;
    var self = this;

    this.setCurrent({
      title: payload.meta.name,
      source: payload.source,
      originDate: new Date(payload.meta.originTime),
      nt: nt,
      dt: payload.timeline.dt,
      ns: ns,
      getValues: function (k) {
        var out = self.scratch;
        for (var i = 0; i < ns; i++) out[i] = rt[i * nt + k] / scale;
        return out;
      },
      final: (function () {
        var f = new Float32Array(ns);
        for (var i = 0; i < ns; i++) f[i] = fin[i] / scale;
        return f;
      })(),
      tp: (function () {
        var a = U.decodeInt16(s.tp), o = new Float32Array(ns);
        for (var i = 0; i < ns; i++) o[i] = a[i] / 10;
        return o;
      })(),
      ts: (function () {
        var a = U.decodeInt16(s.ts), o = new Float32Array(ns);
        for (var i = 0; i < ns; i++) o[i] = a[i] / 10;
        return o;
      })(),
      rupture: payload.source.rupture,
      eew: payload.eew || [],
      aftershocks: payload.aftershocks || [],
      tsunami: payload.tsunami || null,
      precomputed: true
    });
  };

  /* ブラウザ内エンジンの結果を再生用の形に整える */
  App.adoptEngineResult = function (res, title, originDate) {
    var ns = this.stations.lat.length;
    var nt = res.timeline.count;
    var rt = res.realtime;
    var self = this;
    this.setCurrent({
      title: title,
      source: res.source,
      originDate: originDate || new Date(),
      nt: nt,
      dt: res.timeline.dt,
      ns: ns,
      getValues: function (k) {
        var out = self.scratch;
        for (var i = 0; i < ns; i++) out[i] = rt[i * nt + k];
        return out;
      },
      final: res.final,
      tp: res.tp,
      ts: res.ts,
      rupture: null,
      eew: res.eew,
      aftershocks: res.aftershocks,
      tsunami: res.tsunami,
      precomputed: false
    });
  };

  App.setCurrent = function (cur) {
    this.current = cur;
    this.t = 0;
    this.firedReports = 0;
    this.firedTsunami = false;
    this.aftershockQueue = (cur.aftershocks || []).slice();
    if (this.sound) this.sound.cancelSpeech();

    el('track').max = String(cur.nt - 1);
    el('track').value = '0';
    el('scenario-name').textContent = cur.title || '';

    this.phase = 'monitor';
    this.prefIntensity = this.aggregateByPrefecture(cur.final);
    this.waveStations = this.pickWaveStations(cur);
    el('wave-strip').classList.toggle('hidden', !this.panelOn.wave);
    P.hideEEW();
    P.hideTsunami();
    P.hideFinalInfo();
    P.showQuakeInfo({
      region: cur.source.region,
      magnitude: cur.source.magnitude,
      depth: cur.source.depth,
      maxIntensity: cur.source.maxIntensity,
      time: cur.originDate
    });

    this.pushHistory({
      region: cur.source.region,
      magnitude: cur.source.magnitude,
      depth: cur.source.depth,
      maxIntensity: cur.source.maxIntensity,
      time: cur.originDate,
      source: cur.source,
      kind: 'main'
    }, true);

    // 震源が見える程度にビューを合わせる
    var mag = cur.source.magnitude;
    var span = U.clamp(1.2 + (mag - 5) * 0.9, 1.2, 9);
    this.view.proj.fitBounds(
      cur.source.lat - span, cur.source.lon - span * 1.1,
      cur.source.lat + span, cur.source.lon + span * 1.1
    );
    this.view.baseKey = '';
    this.renderMarks();
  };

  /* 都道府県ごとの最大計測震度を求める (確定震度の塗り分け用) */
  App.aggregateByPrefecture = function (finals) {
    var pref = this.stations.pref;
    var out = {};
    for (var i = 0; i < finals.length; i++) {
      var code = pref[i];
      var v = finals[i];
      if (!(v > -3)) continue;
      if (out[code] == null || v > out[code]) out[code] = v;
    }
    return out;
  };

  /* 波形表示に使う観測点を、震源に近い順で距離を散らして選ぶ */
  App.pickWaveStations = function (cur) {
    var st = this.stations, n = st.lat.length;
    var order = [];
    for (var i = 0; i < n; i++) {
      order.push([i, U.haversine(cur.source.lat, cur.source.lon, st.lat[i], st.lon[i])]);
    }
    order.sort(function (a, b) { return a[1] - b[1]; });
    var picks = [], step = Math.max(1, Math.floor(order.length / 400));
    for (var k = 0; k < 8 && k * step < order.length; k++) {
      picks.push(order[k * step * (k + 1)] ? order[k * step * (k + 1)][0] : order[k][0]);
    }
    return picks;
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
    P.renderRecent(this.recentResults, this.activeRecent, function (i, q) {
      self.replay(i, q);
    });
    P.renderHistory(this.history);
  };

  /* 直近リストから選んだ地震を再生する */
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
    P.toast(q.region + ' の地震を再生します');
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
    this.t = k * this.current.dt;
    var atEnd = k >= this.current.nt - 1;
    if (!atEnd && this.phase === 'final') {
      this.phase = 'monitor';
      P.hideFinalInfo();
      el('wave-strip').classList.toggle('hidden', !this.panelOn.wave);
    }
    // 巻き戻したら発表済みの報をリセットする
    this.firedReports = 0;
    this.firedTsunami = false;
    var eew = this.current.eew;
    for (var i = 0; i < eew.length; i++) if (eew[i].issuedAt <= this.t) this.firedReports = i + 1;
    if (this.firedReports > 0) P.showEEW(eew[this.firedReports - 1], this.current.originDate);
    else P.hideEEW();
    if (this.current.tsunami && this.t >= this.current.tsunami.issuedAt && this.panelOn.tsunami) {
      P.showTsunami(this.current.tsunami);
      this.firedTsunami = true;
    } else P.hideTsunami();
  };

  /* タイムライン上の目印 (EEW 各報・津波発表) */
  App.renderMarks = function () {
    var wrap = el('track-marks');
    wrap.innerHTML = '';
    if (!this.current) return;
    var total = (this.current.nt - 1) * this.current.dt;
    var self = this;
    (this.current.eew || []).forEach(function (r) {
      var i2 = document.createElement('i');
      i2.style.left = (100 * r.issuedAt / total) + '%';
      i2.title = '第' + r.number + '報';
      wrap.appendChild(i2);
    });
    if (this.current.tsunami) {
      var m = document.createElement('i');
      m.className = 'tsunami';
      m.style.left = (100 * self.current.tsunami.issuedAt / total) + '%';
      m.title = self.current.tsunami.maxGrade;
      wrap.appendChild(m);
    }
  };

  /* ---------------- 毎フレーム処理 ---------------- */
  App.tick = function (now) {
    var dtReal = Math.min((now - this.lastFrame) / 1000, 0.25);
    this.lastFrame = now;

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

  /* 経過時間に応じて EEW・津波を発表する */
  App.processEvents = function () {
    var cur = this.current;
    var eew = cur.eew || [];
    while (this.firedReports < eew.length && eew[this.firedReports].issuedAt <= this.t) {
      var r = eew[this.firedReports];
      if (this.panelOn.eew) P.showEEW(r, cur.originDate);
      if (this.firedReports === 0) {
        if (r.kind === '警報') this.sound.warning(); else this.sound.forecast();
        this.sound.announceEEW(r);
      } else {
        this.sound.blip();
        // 警報へ格上げされた、または予想震度が変わったときだけ読み上げ直す
        var prev = eew[this.firedReports - 1];
        if (prev && (prev.kind !== r.kind || prev.maxShindo !== r.maxShindo)) {
          this.sound.announceEEW(r);
        }
      }
      this.firedReports++;
    }

    if (cur.tsunami && !this.firedTsunami && this.t >= cur.tsunami.issuedAt) {
      if (this.panelOn.tsunami) P.showTsunami(cur.tsunami);
      this.sound.tsunami(cur.tsunami.maxLevel);
      this.sound.announceTsunami(cur.tsunami);
      this.firedTsunami = true;
      P.toast(cur.tsunami.maxGrade + ' が発表されました');
    }

    // 主要動到達までのカウントダウン (画面中心の最寄り観測点)
    if (this.firedReports > 0) {
      var idx = this.centerStation();
      if (idx >= 0) {
        var ts = cur.ts[idx];
        var left = ts - this.t;
        var name = this.stations.name[idx];
        if (left > 0 && left < 60) {
          P.setCountdown(name + ' 主要動まで 約' + Math.ceil(left) + '秒');
          var whole = Math.ceil(left);
          if (whole !== this._lastTick && whole <= 10) {
            this._lastTick = whole;
            this.sound.tick(whole <= 1);
          }
        } else if (left <= 0 && left > -8) {
          P.setCountdown(name + ' 主要動到達');
        } else {
          P.setCountdown('');
        }
      }
    }
  };

  App.centerStation = function () {
    if (this._centerIdx != null && this._centerKey === this.view.viewKey()) return this._centerIdx;
    var c = this.view.proj.unproject(this.view.cssWidth / 2, this.view.cssHeight / 2);
    var st = this.stations, best = -1, bestD = Infinity;
    for (var i = 0; i < st.lat.length; i++) {
      var d = U.haversine(c[0], c[1], st.lat[i], st.lon[i]);
      if (d < bestD) { bestD = d; best = i; }
    }
    this._centerIdx = best;
    this._centerKey = this.view.viewKey();
    return best;
  };

  /* 本震の再生が終わったら余震の再生を予約する */
  App.onPlaybackEnd = function () {
    var cur = this.current;
    if (!cur) return;
    // 揺れが収まったら観測された震度の確定表示に切り替える
    this.phase = 'final';
    P.hideEEW();
    el('wave-strip').classList.add('hidden');
    P.showFinalInfo({
      region: cur.source.region,
      magnitude: cur.source.magnitude,
      depth: cur.source.depth,
      maxIntensity: cur.source.maxIntensity,
      time: cur.originDate,
      tsunami: cur.tsunami
    });
    this.sound.info();
    this.sound.announceQuake({
      region: cur.source.region,
      shindo: cur.source.maxShindo,
      magnitude: cur.source.magnitude,
      depth: cur.source.depth
    });
    if (!cur.aftershocks || !cur.aftershocks.length) return;
    var notable = cur.aftershocks.filter(function (a) { return a.maxIntensity >= 1.5; }).slice(0, 8);
    if (!notable.length) return;

    var self = this;
    var i = 0;
    P.toast('余震活動を再生します（' + notable.length + '回）');
    function next() {
      if (i >= notable.length || self._abortAftershocks) return;
      var a = notable[i++];
      var when = new Date(cur.originDate.getTime() + a.time * 1000);
      self.pushHistory({
        region: a.region, magnitude: a.magnitude, depth: a.depth,
        maxIntensity: a.maxIntensity, time: when,
        source: { lat: a.lat, lon: a.lon, depth: a.depth, magnitude: a.magnitude, kind: cur.source.kind },
        kind: 'aftershock'
      }, true);
      var res = self.engine.simulate({
        lat: a.lat, lon: a.lon, depth: a.depth, magnitude: a.magnitude,
        kind: cur.source.kind, strike: 0, dip: 45, rake: 90
      }, { duration: 120, aftershocks: false, tsunami: false, seed: 900 + i });
      self.adoptEngineResultKeepHistory(res, '余震 ' + a.region + ' ' + U.formatMagnitude(a.magnitude), when);
      self.play(true);
      setTimeout(next, 11000);
    }
    // 確定した地震情報を読める時間を確保してから余震に移る
    setTimeout(next, 9000);
  };

  /* 余震再生では履歴を二重登録しない */
  App.adoptEngineResultKeepHistory = function (res, title, when) {
    var pushed = this.pushHistory;
    this.pushHistory = function () {};
    this.adoptEngineResult(res, title, when);
    this.pushHistory = pushed;
    this.refreshLists();
  };

  /* ---------------- 描画 ---------------- */
  App.draw = function () {
    var v = this.view;
    v.clear();
    var cur = this.current;

    if (cur) {
      var k = U.clamp(Math.round(this.t / cur.dt), 0, cur.nt - 1);

      if (this.phase === 'final') {
        // 確定震度: 地域を観測震度で塗り分けて震度バッジを置く
        v.drawObservedAreas(this.prefIntensity);
        v.drawStationDots(cur.final);
        v.drawAreaBadges(this.prefIntensity);
      } else {
        v.drawStations(cur.getValues(k));
      }

      if (cur.tsunami && this.firedTsunami) v.drawTsunami(cur.tsunami, this.t);
      if (this.phase === 'monitor') {
        if (cur.rupture) v.drawRupture(cur.rupture, this.t);
        // P/S 波面 (発震時からの経過時間に対応する半径)
        var pr = this.waveRadius('P', cur.source.depth, this.t);
        var sr = this.waveRadius('S', cur.source.depth, this.t);
        if (this.t > 0) v.drawWavefronts(cur.source.lat, cur.source.lon, pr, sr);
      }

      var pulse = (this.t % 2) / 2;
      v.drawEpicenter(cur.source.lat, cur.source.lon,
                      this.phase === 'monitor' && this.t < 30 ? pulse : 0);

      el('tl-elapsed').textContent = U.formatElapsed(this.t);
      if (this.panelOn.wave && this.phase === 'monitor') this.drawWaveStrip(k);
      if (this.phase === 'monitor' && this.firedReports > 0) {
        var vals = cur.getValues(k), mx = -3;
        for (var q = 0; q < vals.length; q++) if (vals[q] > mx) mx = vals[q];
        P.setRealtimeMax(mx);
      }
    } else {
      v.drawStations(null);
    }
    if (this.mode === 'config' && this._preview) {
      v.drawSourcePreview(this._preview.src, this._preview.dim);
    }
    v.drawScaleBar();
    this.updateClock();
  };

  /* 観測波形 (ドラムロール風) の描画
   * リアルタイム震度から振幅 a = 10^((I - 0.94) / 2) [gal] を逆算し、
   * 高周波の揺らぎを重ねて時刻歴らしく見せる。 */
  App.drawWaveStrip = function (k) {
    var cv = el('wave-canvas');
    if (!cv || !this.waveStations || !this.current) return;
    var rect = cv.getBoundingClientRect();
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    if (cv.width !== Math.round(rect.width * dpr)) {
      cv.width = Math.round(rect.width * dpr);
      cv.height = Math.round(rect.height * dpr);
    }
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var w = rect.width, h = rect.height;
    ctx.clearRect(0, 0, w, h);

    var cur = this.current;
    var rows = this.waveStations.length;
    var rowH = h / rows;
    var span = 40;                       // 表示する秒数
    var k0 = Math.max(0, k - span);
    var pts = k - k0 + 1;
    if (pts < 2) return;

    ctx.lineWidth = 1;
    ctx.strokeStyle = '#e8f2ff';
    for (var r = 0; r < rows; r++) {
      var idx = this.waveStations[r];
      var yMid = rowH * (r + 0.5);
      ctx.beginPath();
      for (var j = 0; j <= k - k0; j++) {
        var kk = k0 + j;
        var vals = cur.getValues(kk);
        var inten = vals[idx];
        var amp = inten > -3 ? Math.pow(10, (inten - 0.94) / 2) : 0;
        var norm = Math.min(Math.log10(1 + amp) / 2.6, 1);   // 0..1
        // 擬似的な高周波成分 (観測点と時刻で決まる決定論的な揺らぎ)
        var osc = Math.sin(kk * 12.9898 + idx * 78.233) * Math.sin(kk * 3.7 + r);
        var y = yMid - norm * (rowH * 0.46) * osc;
        var x = (j / (pts - 1)) * (w - 4) + 2;
        if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      if (r < rows - 1) {
        ctx.strokeStyle = 'rgba(255,255,255,.18)';
        ctx.beginPath();
        ctx.moveTo(0, rowH * (r + 1)); ctx.lineTo(w, rowH * (r + 1));
        ctx.stroke();
        ctx.strokeStyle = '#e8f2ff';
      }
    }
  };

  /* 走時表を逆に引いて、経過時間に対応する波面半径 [km] を求める */
  App.waveRadius = function (phase, depth, t) {
    if (t <= 0) return 0;
    var tt = this.engine.tt;
    var x = tt.distances;
    var lo = 0, hi = 2000;
    for (var i = 0; i < 24; i++) {
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
  App.readConfig = function () {
    var timeStr = el('cfg-time').value;
    var origin = new Date();
    if (timeStr) {
      var parts = timeStr.split(':');
      origin.setHours(+parts[0] || 0, +parts[1] || 0, +(parts[2] || 0), 0);
    }
    return {
      lat: parseFloat(el('cfg-lat').value),
      lon: parseFloat(el('cfg-lon').value),
      depth: parseFloat(el('cfg-depth').value),
      magnitude: parseFloat(el('cfg-mag').value),
      kind: el('cfg-kind').value,
      strike: parseFloat(el('cfg-strike').value),
      dip: parseFloat(el('cfg-dip').value),
      rake: parseFloat(el('cfg-rake').value),
      origin: origin,
      aftershocks: el('cfg-aftershock').checked,
      tsunami: el('cfg-tsunami').checked,
      eew: el('cfg-eew').checked
    };
  };

  App.updateConfigPreview = function () {
    var c = this.readConfig();
    if (!isFinite(c.lat) || !isFinite(c.lon)) return;
    el('cfg-region').value = this.regions.nameAt(c.lat, c.lon);
    var dim = this.engine.faultDimensions(c.magnitude, c.kind);
    var onLand = this.landmask.isLand(c.lat, c.lon);
    this._preview = { src: c, dim: dim };
    el('config-preview').innerHTML =
      '想定断層 ' + dim.length.toFixed(0) + ' x ' + dim.width.toFixed(0) + ' km' +
      '（面積 ' + dim.area.toFixed(0) + ' km²）<br>' +
      '震源域: ' + (onLand ? '陸域' : '海域') +
      ' / 津波: ' + (!onLand && c.depth <= 60 && c.magnitude >= 6.0 ? '発生の可能性あり' : 'なし');
  };

  App.runConfig = function () {
    var c = this.readConfig();
    if (!isFinite(c.lat) || !isFinite(c.lon) || !isFinite(c.magnitude)) {
      P.toast('入力値を確認してください'); return;
    }
    P.toast('計算中…');
    var self = this;
    setTimeout(function () {
      var res = self.engine.simulate(c, {
        duration: 240, aftershocks: c.aftershocks, tsunami: c.tsunami,
        eew: c.eew, aftershockDays: 3, seed: Date.now() & 0xffff
      });
      self._abortAftershocks = false;
      self.adoptEngineResult(res, c.magnitude.toFixed(1) + ' ' + res.source.region, c.origin);
      self.setMode('visual');
      self.play(true);
      P.toast(res.source.region + ' M' + c.magnitude.toFixed(1) +
              ' 最大震度' + res.source.maxShindo);
    }, 30);
  };

  App.loadScenario = function (entry) {
    var self = this;
    P.toast('シナリオを読み込み中…');
    fetchJSON('data/scenarios/' + entry.file).then(function (payload) {
      self._abortAftershocks = false;
      self.adoptScenario(payload);
      self.setMode('visual');
      self.play(true);
      P.toast(payload.meta.name + ' を再生します');
    }).catch(function (e) { P.toast(e.message); });
  };

  App.renderScenarioList = function () {
    var ul = el('scenario-list');
    ul.innerHTML = '';
    var self = this;
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
      var n = document.createElement('div'); n.className = 'sl-name'; n.textContent = s.name;
      var sub = document.createElement('div'); sub.className = 'sl-sub';
      sub.textContent = U.formatMagnitude(s.magnitude) + ' / ' + U.formatDepth(s.depth) +
                        ' / 最大震度' + s.maxShindo + (s.tsunami ? ' / ' + s.tsunami : '');
      main.appendChild(n); main.appendChild(sub);
      li.appendChild(badge); li.appendChild(main);
      li.addEventListener('click', function () { self.loadScenario(s); });
      ul.appendChild(li);
    });
  };

  /* ---------------- モード ---------------- */
  App.setMode = function (mode) {
    this.mode = mode;
    el('mode-visual').classList.toggle('active', mode === 'visual');
    el('mode-config').classList.toggle('active', mode === 'config');
    el('mode-visual').setAttribute('aria-selected', String(mode === 'visual'));
    el('mode-config').setAttribute('aria-selected', String(mode === 'config'));
    el('config-panel').classList.toggle('hidden', mode !== 'config');
    el('info-panel').classList.toggle('hidden', mode === 'config');
    this.view.canvas.classList.toggle('picking', mode === 'config');
    if (mode === 'config') {
      this.updateConfigPreview();
      this.renderScenarioList();
    } else {
      this._preview = null;
    }
  };

  /* ---------------- 入力 ---------------- */
  App.bind = function () {
    var self = this;
    var canvas = this.view.canvas;

    el('mode-visual').addEventListener('click', function () { self.setMode('visual'); });
    el('mode-config').addEventListener('click', function () { self.setMode('config'); });

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

    // 地図の操作
    var dragging = false, lastX = 0, lastY = 0, moved = 0;
    canvas.addEventListener('pointerdown', function (e) {
      dragging = true; moved = 0; lastX = e.clientX; lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
      canvas.classList.add('dragging');
      self.sound.unlock();
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - lastX, dy = e.clientY - lastY;
      moved += Math.abs(dx) + Math.abs(dy);
      lastX = e.clientX; lastY = e.clientY;
      self.view.proj.panByPixels(dx, dy);
      self.view.baseKey = '';
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
      var rect = canvas.getBoundingClientRect();
      var f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      self.view.proj.zoomAt(f, e.clientX - rect.left, e.clientY - rect.top);
      self.view.baseKey = '';
    }, { passive: false });

    // 左の縦アイコン列: パネルの表示切替
    function railToggle(btnId, key, panelId) {
      el(btnId).addEventListener('click', function () {
        self.panelOn[key] = !self.panelOn[key];
        this.classList.toggle('active', self.panelOn[key]);
        if (panelId) {
          var show = self.panelOn[key] && !el(panelId).dataset.forceHidden;
          el(panelId).classList.toggle('hidden', !show);
        }
      });
    }
    railToggle('rail-info', 'info', 'info-panel');
    railToggle('rail-eew', 'eew', null);
    railToggle('rail-tsunami', 'tsunami', null);
    el('rail-sound').addEventListener('click', function () {
      self.panelOn.sound = !self.panelOn.sound;
      this.classList.toggle('active', self.panelOn.sound);
      self.sound.setEnabled(self.panelOn.sound);
      el('sound-toggle').checked = self.panelOn.sound;
    });
    el('rail-close').addEventListener('click', function () {
      var any = self.panelOn.info || self.panelOn.eew || self.panelOn.wave;
      self.panelOn.info = self.panelOn.eew = self.panelOn.wave = !any;
      ['rail-info', 'rail-eew'].forEach(function (id) {
        el(id).classList.toggle('active', !any);
      });
      el('info-panel').classList.toggle('hidden', any);
      el('wave-strip').classList.toggle('hidden', any || self.phase !== 'monitor');
      if (any) P.hideEEW();
    });

    // 観測点の表示スタイル (震度の数字入り / 色のみ)
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

    // ズーム操作
    el('zoom-in').addEventListener('click', function () {
      self.view.proj.zoomAt(1.4, self.view.cssWidth / 2, self.view.cssHeight / 2);
      self.view.baseKey = '';
    });
    el('zoom-out').addEventListener('click', function () {
      self.view.proj.zoomAt(1 / 1.4, self.view.cssWidth / 2, self.view.cssHeight / 2);
      self.view.baseKey = '';
    });
    el('zoom-fit').addEventListener('click', function () {
      if (self.current) {
        var mag = self.current.source.magnitude;
        var span = U.clamp(1.2 + (mag - 5) * 0.9, 1.2, 9);
        self.view.proj.fitBounds(
          self.current.source.lat - span, self.current.source.lon - span * 1.1,
          self.current.source.lat + span, self.current.source.lon + span * 1.1
        );
      } else {
        self.view.proj.fitBounds(30.0, 128.0, 45.5, 146.0);
      }
      self.view.baseKey = '';
    });

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
    var mag = Math.round((5.5 + Math.random() * 3.0) * 10) / 10;
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
      self.view.proj.fitBounds(30.0, 128.0, 45.5, 146.0);
      self.setMode('visual');
      if (self.scenarioIndex.length) {
        self.loadScenario(self.scenarioIndex[0]);
      } else {
        P.toast('設定モードから震源を指定してください');
      }
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
