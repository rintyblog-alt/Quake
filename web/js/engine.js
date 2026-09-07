/* ブラウザ内シミュレーションエンジン
 *
 * 設定モードで指定された震源に対し、その場で全国の震度分布・
 * リアルタイム震度の時系列・緊急地震速報の発表列・余震・津波を計算する。
 *
 * 距離減衰は司・翠川 (1999)、サイト増幅は藤本・翠川 (2006)、
 * 震度換算は藤本・翠川 (2005) による。走時は Python 側の 1 次元速度構造から
 * 書き出した走時表を内挿して用いる。
 * (Python 側の確率論的波形合成に比べ簡易だが、震度分布と到達時刻は整合する)
 */
(function (global) {
  'use strict';

  var DEPTH_TERM = { crustal: 0.0, interplate: 0.28, intraslab: 0.30 };
  var STRESS = { crustal: 100.0, interplate: 60.0, intraslab: 200.0 };

  /* ---------------- 地震動のばらつき ----------------
   * 距離減衰式が与えるのは中央値なので、そのまま使うと震度分布が
   * 震源からの距離だけで決まる同心円の縞になり、隣り合う観測点が
   * 必ず同じ震度になってしまう。Python 側の sim/variability.py と
   * 同じ残差モデル (観測点固有の項 + 空間相関を持つ経路の項) を使う。
   */
  var PHI_SITE = 0.30;      // 観測点固有 (震度単位)
  var PHI_PATH = 0.24;      // 経路 (震度単位)
  var CORR_LEN_KM = 25.0;   // Jayaram & Baker (2009): rho(h) = exp(-3h/b)
  var N_MODES = 256;
  // 振幅依存の σ: 強い揺れでは地盤が非線形化して観測点ごとの差が縮まる
  var SIGMA_FULL = 4.0, SIGMA_FLOOR_AT = 6.5, SIGMA_FLOOR = 0.40;

  function sigmaScale(intensity) {
    var t = (intensity - SIGMA_FULL) / (SIGMA_FLOOR_AT - SIGMA_FULL);
    return Math.min(1, Math.max(SIGMA_FLOOR, 1 - (1 - SIGMA_FLOOR) * t));
  }

  /* MurmurHash3 の finalizer。Python 側と同じ値を返す。 */
  function fmix32(x) {
    x = x | 0;
    x = Math.imul(x ^ (x >>> 16), 0x85EBCA6B);
    x = Math.imul(x ^ (x >>> 13), 0xC2B2AE35);
    return (x ^ (x >>> 16)) >>> 0;
  }

  /* 観測点の座標から決まる固定の標準正規乱数 (Box-Muller)。
   * 同じ観測点はどの地震でも同じ向きにずれる (サイトの繰り返し性)。 */
  function siteTerms(lat, lon) {
    var n = lat.length, out = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var a = Math.imul(Math.round(lat[i] * 1000) | 0, 0x8DA6B343);
      var b = Math.imul(Math.round(lon[i] * 1000) | 0, 0xD8163841);
      var key = (a ^ b) | 0;
      var u1 = Math.max(fmix32(key) / 4294967296, 1 / 4294967296);
      var u2 = fmix32((key ^ 0x9E3779B1) | 0) / 4294967296;
      out[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    }
    return out;
  }

  /* 空間相関 exp(-3h/b) を持つ平均 0・分散 1 のガウス場。
   * 指数型の相関は Matern (nu=1/2) にあたり、その波数スペクトルは
   * 2 次元のコーシー分布になる。ランダムフーリエ級数
   *   psi(x) = sqrt(2/M) * sum_j cos(k_j . x + phi_j)
   * の波数をそこから引けば、相関関数がそのまま再現される。 */
  function pathField(lat, lon, rng) {
    var n = lat.length, out = new Float32Array(n);
    if (!n) return out;
    var lat0 = 0, lon0 = 0, i, j;
    for (i = 0; i < n; i++) { lat0 += lat[i]; lon0 += lon[i]; }
    lat0 /= n; lon0 /= n;
    var kmPerLon = 111.32 * Math.cos(lat0 * Math.PI / 180);
    var ell = CORR_LEN_KM / 3.0;

    var kx = new Float64Array(N_MODES), ky = new Float64Array(N_MODES);
    var ph = new Float64Array(N_MODES);
    for (j = 0; j < N_MODES; j++) {
      var z1 = gauss(rng), z2 = gauss(rng);
      var g = Math.max(Math.abs(gauss(rng)), 1e-3);
      kx[j] = z1 / (g * ell);
      ky[j] = z2 / (g * ell);
      ph[j] = rng() * 2 * Math.PI;
    }
    var scale = Math.sqrt(2 / N_MODES);
    for (i = 0; i < n; i++) {
      var x = (lon[i] - lon0) * kmPerLon, y = (lat[i] - lat0) * 111.32, sum = 0;
      for (j = 0; j < N_MODES; j++) sum += Math.cos(kx[j] * x + ky[j] * y + ph[j]);
      out[i] = scale * sum;
    }
    return out;
  }

  function gauss(rng) {
    var u = Math.max(rng(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  }

  function Engine(data) {
    this.stations = data.stations;      // {lat, lon, avs30, region, name}
    this.tt = data.traveltime;          // {depths, distances, p[][], s[][]}
    this.regions = data.regions;        // EpicenterRegions 相当
    this.tsunamiZones = data.tsunamiZones;
    this.landmask = data.landmask;
    this.arv = new Float32Array(this.stations.avs30.length);
    for (var i = 0; i < this.arv.length; i++) {
      var v = Math.min(1500, Math.max(100, this.stations.avs30[i]));
      this.arv[i] = Math.pow(10, 1.83 - 0.66 * Math.log10(v));
    }
    // 観測点固有の残差は地震によらず一定なので、ここで一度だけ求める
    this.siteResid = siteTerms(this.stations.lat, this.stations.lon);
  }

  /* この地震の残差 [震度単位] */
  Engine.prototype.residual = function (rng) {
    var site = this.siteResid, n = site.length;
    var out = new Float32Array(n);
    var path = rng ? pathField(this.stations.lat, this.stations.lon, rng) : null;
    for (var i = 0; i < n; i++) {
      out[i] = PHI_SITE * site[i] + (path ? PHI_PATH * path[i] : 0);
    }
    return out;
  };

  /* ---------------- 走時 ---------------- */
  Engine.prototype.travelTime = function (phase, depthKm, distKm) {
    var t = this.tt, table = phase === 'P' ? t.p : t.s;
    var d = t.depths, x = t.distances;
    // 深さ方向の内挿
    var di = 0;
    while (di < d.length - 2 && d[di + 1] < depthKm) di++;
    var wt = (depthKm - d[di]) / (d[di + 1] - d[di]);
    wt = Math.max(0, Math.min(1, wt));
    // 距離方向の内挿
    var step = x[1] - x[0];
    var xi = Math.floor(distKm / step);
    if (xi < 0) xi = 0;
    if (xi >= x.length - 1) {
      // 表の外は末端の見かけ速度で外挿する
      var last = x.length - 1;
      var slope0 = (table[di][last] - table[di][last - 1]) / step;
      var slope1 = (table[di + 1][last] - table[di + 1][last - 1]) / step;
      var t0 = table[di][last] + (distKm - x[last]) * slope0;
      var t1 = table[di + 1][last] + (distKm - x[last]) * slope1;
      return t0 + (t1 - t0) * wt;
    }
    var wx = (distKm - x[xi]) / step;
    var a = table[di][xi] + (table[di][xi + 1] - table[di][xi]) * wx;
    var b = table[di + 1][xi] + (table[di + 1][xi + 1] - table[di + 1][xi]) * wx;
    return a + (b - a) * wt;
  };

  /* ---------------- 断層寸法 ---------------- */
  /* Python 側の sim/source.py と同じスケーリング則を用いる */
  Engine.prototype.faultDimensions = function (mag, kind, dip) {
    var m0 = Math.pow(10, 1.5 * mag + 9.1) * 1e7; // dyne*cm
    var area;
    if (kind === 'interplate') area = 1.48e-10 * Math.sqrt(m0);
    else if (m0 <= 7.5e25) area = 2.23e-15 * Math.pow(m0, 2 / 3);
    else area = 4.24e-11 * Math.sqrt(m0);

    // 幅は地震発生層の厚さで頭打ちにする。低角の断層ほど幅を取れる。
    var seismo = kind === 'crustal' ? 20 : 60;
    var sinDip = Math.max(Math.sin((dip == null ? 45 : dip) * Math.PI / 180), 0.2);
    var w = Math.min(Math.sqrt(area / 2), seismo / sinDip);
    return { area: area, length: area / w, width: w };
  };

  /* 断層面の地表投影までの最短距離 Rjb [km]
   * 観測点を走向方向 u・直交方向 v の座標に移し、断層の矩形に押し込めて測る。 */
  function joynerBooreDistance(src, dim, lat, lon) {
    var toRad = Math.PI / 180;
    var latRef = src.lat * toRad;
    var east = (lon - src.lon) * toRad * 6371.0088 * Math.cos(latRef);
    var north = (lat - src.lat) * toRad * 6371.0088;

    var strike = (src.strike || 0) * toRad;
    // 走向方向の単位ベクトルは (sin, cos)、その右手直交が傾斜下方向の水平投影
    var u = east * Math.sin(strike) + north * Math.cos(strike);
    var v = east * Math.cos(strike) - north * Math.sin(strike);

    var halfL = dim.length / 2;
    var projW = dim.width * Math.cos((src.dip == null ? 45 : src.dip) * Math.PI / 180);
    var du = Math.max(Math.abs(u) - halfL, 0);
    // 破壊開始点は幅方向の 0.6 の位置にあるとみなす
    var v0 = -0.6 * projW, v1 = 0.4 * projW;
    var dv = v < v0 ? v0 - v : (v > v1 ? v - v1 : 0);
    return Math.sqrt(du * du + dv * dv);
  }

  /* ---------------- 震度分布 ---------------- */
  Engine.prototype.intensityField = function (src, resid) {
    var st = this.stations, n = st.lat.length;
    var dim = this.faultDimensions(src.magnitude, src.kind, src.dip);
    var d = DEPTH_TERM[src.kind] || 0;
    var depth = Math.min(src.depth, 120);
    var c = 0.0028 * Math.pow(10, 0.5 * src.magnitude);

    var inten = new Float32Array(n);
    var tp = new Float32Array(n);
    var ts = new Float32Array(n);
    var rr = new Float32Array(n);

    for (var i = 0; i < n; i++) {
      var epi = global.Util.haversine(src.lat, src.lon, st.lat[i], st.lon[i]);
      // 断層面の広がりを考慮した距離 (地表投影までの最短距離と深さから)
      var rjb = joynerBooreDistance(src, dim, st.lat[i], st.lon[i]);
      var r = Math.max(Math.sqrt(rjb * rjb + src.depth * src.depth), 3);
      rr[i] = r;

      var logPgv = 0.58 * src.magnitude + 0.0038 * depth + d - 1.29
                 - Math.log10(r + c) - 0.002 * r;
      var pgv = Math.pow(10, logPgv) * this.arv[i];
      var median = 2.68 + 1.72 * Math.log10(Math.max(pgv, 1e-6));
      inten[i] = median + (resid ? resid[i] * sigmaScale(median) : 0);

      tp[i] = this.travelTime('P', src.depth, epi);
      ts[i] = this.travelTime('S', src.depth, epi);
    }
    return { intensity: inten, tp: tp, ts: ts, r: rr, dim: dim };
  };

  /* ---------------- リアルタイム震度の時系列 ----------------
   * S 波到達で立ち上がり、震源継続時間だけ保持したのち減衰する包絡を与える。
   * P 波区間は本体より 2.5 程度小さい値とする。
   */
  Engine.prototype.timeline = function (field, src, duration, dt) {
    var n = field.intensity.length;
    var nt = Math.round(duration / dt);
    var out = new Float32Array(n * nt);
    var dim = field.dim;
    var rupture = dim.length / (0.72 * 3.4) * 0.6 + 2;

    for (var i = 0; i < n; i++) {
      var peak = field.intensity[i];
      var base = i * nt;
      if (peak < -2.5) { for (var q = 0; q < nt; q++) out[base + q] = -3; continue; }
      var tP = field.tp[i], tS = field.ts[i];
      // 継続時間: 震源継続時間 + 経路による伸び
      var hold = rupture + 0.05 * field.r[i] + 2;
      var rise = 1.5 + 0.01 * field.r[i];
      var decay = 0.08 + 2.0 / Math.max(hold, 4);
      var pLevel = peak - 2.5;

      for (var k = 0; k < nt; k++) {
        var t = k * dt, v;
        if (t < tP - 0.5) v = -3;
        else if (t < tS) {
          var up = global.Util.clamp((t - tP) / 1.2, 0, 1);
          v = -3 + (pLevel + 3) * up;
        } else if (t < tS + rise) {
          v = pLevel + (peak - pLevel) * ((t - tS) / rise);
        } else if (t < tS + rise + hold) {
          v = peak - 0.25 * (t - tS - rise) / Math.max(hold, 1);
        } else {
          v = peak - 0.25 - decay * (t - tS - rise - hold);
        }
        out[base + k] = Math.max(-3, v);
      }
    }
    return { data: out, nt: nt, dt: dt };
  };

  /* ---------------- 緊急地震速報 ---------------- */
  Engine.prototype.eewReports = function (field, src) {
    var st = this.stations;
    var n = field.tp.length;
    // 検知順に観測点を並べる
    var idx = [];
    for (var i = 0; i < n; i++) if (field.intensity[i] > -1.0) idx.push(i);
    idx.sort(function (a, b) { return field.tp[a] - field.tp[b]; });
    if (idx.length < 2) return [];

    var reports = [];
    var t = field.tp[idx[1]] + 1.0;
    var trueMax = -3;
    for (i = 0; i < n; i++) if (field.intensity[i] > trueMax) trueMax = field.intensity[i];

    var num = 0;
    var maxReports = 12;
    while (num < maxReports) {
      // 発表時点で検知済みの観測点数
      var used = 0;
      for (i = 0; i < idx.length; i++) { if (field.tp[idx[i]] <= t - 1.0) used++; else break; }
      if (used < 2) { t += 1.0; continue; }

      // 推定は観測点が増えるほど真値に収束する
      var conv = 1 - Math.exp(-used / 12);
      var noiseM = (1 - conv) * 0.9 * Math.sin(num * 2.399 + 1.1);
      var mag = src.magnitude - (1 - conv) * 0.8 + noiseM;
      mag = Math.max(3, Math.min(9.5, mag));

      var noiseP = (1 - conv) * 0.35;
      var lat = src.lat + noiseP * Math.sin(num * 1.7);
      var lon = src.lon + noiseP * Math.cos(num * 2.3);
      var depth = Math.max(2, src.depth * (1 + (1 - conv) * 0.5 * Math.sin(num * 3.1)));

      // 推定 M での予測最大震度
      var predicted = trueMax + 1.72 * 0.58 * (mag - src.magnitude);
      predicted = global.Util.roundIntensity(predicted);
      var kind = predicted >= 4.5 ? '警報' : '予報';

      num++;
      reports.push({
        number: num,
        issuedAt: Math.round(t * 10) / 10,
        lat: Math.round(lat * 1000) / 1000,
        lon: Math.round(lon * 1000) / 1000,
        depth: Math.round(depth),
        magnitude: Math.round(mag * 10) / 10,
        maxIntensity: predicted,
        maxShindo: global.Util.shindoClass(predicted),
        region: this.regions.nameAt(lat, lon),
        kind: kind,
        isFinal: false,
        stations: used,
        warningRegions: kind === '警報' ? this.warningRegions(field, predicted) : []
      });

      if (num >= 6 && conv > 0.93) break;
      t += num >= 5 ? 2.0 : 1.0;
    }
    if (reports.length) reports[reports.length - 1].isFinal = true;
    return reports;
  };

  Engine.prototype.warningRegions = function (field, threshold) {
    var st = this.stations, seen = {}, out = [];
    var order = [];
    for (var i = 0; i < field.intensity.length; i++) {
      if (field.intensity[i] >= 4.5) order.push(i);
    }
    order.sort(function (a, b) { return field.intensity[b] - field.intensity[a]; });
    for (var k = 0; k < order.length && out.length < 12; k++) {
      var name = this.regions.nameByCode(st.region[order[k]]);
      if (name && !seen[name]) { seen[name] = 1; out.push(name); }
    }
    return out;
  };

  /* ---------------- 余震 ---------------- */
  Engine.prototype.aftershocks = function (src, days, mMin, rng) {
    var mMax = src.magnitude - 1.2;
    if (mMax <= mMin) return [];
    var b = 0.9, p = 1.08, c = 0.02;
    var expected = Math.pow(10, b * mMax - b * mMin);
    var count = Math.min(Math.round(expected * (0.75 + 0.5 * rng())), 300);
    var dim = this.faultDimensions(src.magnitude, src.kind, src.dip);
    var scatter = Math.max(dim.width * 0.35, 4);
    var beta = b * Math.LN10;
    var denom = 1 - Math.exp(-beta * (mMax - mMin));

    var lo = Math.pow(c, 1 - p), hi = Math.pow(days + c, 1 - p);
    var out = [];
    for (var i = 0; i < count; i++) {
      var tDay = Math.pow(lo + rng() * (hi - lo), 1 / (1 - p)) - c;
      var m = mMin - Math.log(1 - rng() * denom) / beta;
      var dLat = (rng() - 0.5) * 2 * scatter / 111.32;
      var dLon = (rng() - 0.5) * 2 * scatter / (111.32 * Math.cos(src.lat * Math.PI / 180));
      var lat = src.lat + dLat, lon = src.lon + dLon;
      var depth = Math.max(2, src.depth + (rng() - 0.5) * scatter);
      out.push({
        time: tDay * 86400, lat: lat, lon: lon, depth: depth,
        magnitude: Math.round(m * 10) / 10,
        region: this.regions.nameAt(lat, lon),
        maxIntensity: 0
      });
    }
    // 最大余震を 1 個含める (Bath の法則)
    if (out.length) {
      out[0].magnitude = Math.round((mMax - rng() * 0.2) * 10) / 10;
    }
    out.sort(function (a, b2) { return a.time - b2.time; });

    // 各余震の最大震度を距離減衰式で評価する (走時は不要なので簡易版を使う)
    for (i = 0; i < out.length; i++) {
      out[i].maxIntensity = this.maxIntensity({
        lat: out[i].lat, lon: out[i].lon, depth: out[i].depth,
        magnitude: out[i].magnitude, kind: src.kind
      });
    }
    return out;
  };

  /* 最大震度だけを求める軽量版 (余震の一覧表示用) */
  Engine.prototype.maxIntensity = function (src) {
    var st = this.stations, n = st.lat.length;
    var d = DEPTH_TERM[src.kind] || 0;
    var depth = Math.min(src.depth, 120);
    var c = 0.0028 * Math.pow(10, 0.5 * src.magnitude);
    var best = -3;
    for (var i = 0; i < n; i++) {
      var epi = global.Util.haversine(src.lat, src.lon, st.lat[i], st.lon[i]);
      var r = Math.max(Math.sqrt(epi * epi + src.depth * src.depth), 3);
      if (r > 300) continue;
      var logPgv = 0.58 * src.magnitude + 0.0038 * depth + d - 1.29
                 - Math.log10(r + c) - 0.002 * r;
      var med = 2.68 + 1.72 * (logPgv + Math.log10(this.arv[i]));
      var v = med + PHI_SITE * this.siteResid[i] * sigmaScale(med);
      if (v > best) best = v;
    }
    return global.Util.roundIntensity(best);
  };

  /* ---------------- 津波 ---------------- */
  Engine.prototype.tsunami = function (src) {
    if (!this.tsunamiZones || !this.landmask) return null;
    if (this.landmask.isLand(src.lat, src.lon)) return null;
    if (src.depth > 60 || src.magnitude < 6.0) return null;

    // 海底の上下変位はすべりの傾斜方向成分で決まるため、
    // 横ずれ断層 (rake が 0 度・180 度付近) はほとんど津波を生じない
    var sr = Math.sin(src.rake * Math.PI / 180);
    var eff = 0.08 + 0.92 * sr * sr;
    var zones = [];
    for (var z = 0; z < this.tsunamiZones.length; z++) {
      var zone = this.tsunamiZones[z];
      var best = -1, bestD = Infinity;
      for (var k = 0; k < zone.coast.length; k++) {
        var d = global.Util.haversine(src.lat, src.lon, zone.coast[k][0], zone.coast[k][1]);
        if (d < bestD && !this.landmask.blocked(src.lat, src.lon, zone.coast[k][0], zone.coast[k][1])) {
          bestD = d; best = k;
        }
      }
      if (best < 0) continue;
      var delta = Math.max(bestD, 10);
      var h = eff * Math.pow(10, src.magnitude - Math.log10(delta) - 5.55);
      if (delta > 100) h *= Math.pow(delta / 100, -0.35);
      if (h < 0.05) continue;

      var level = h >= 3 ? 3 : (h >= 1 ? 2 : (h >= 0.2 ? 1 : 0));
      var grade = ['津波予報', '津波注意報', '津波警報', '大津波警報'][level];
      zones.push({
        code: zone.code, name: zone.name, grade: grade, level: level,
        height: Math.round(h * 100) / 100,
        heightClass: heightClass(h),
        arrival: Math.round(delta / 0.15 + 420),
        lat: zone.coast[best][0], lon: zone.coast[best][1]
      });
    }
    if (!zones.length) return null;
    zones.sort(function (a, b) { return (b.level - a.level) || (a.arrival - b.arrival); });
    return { issuedAt: 180, maxGrade: zones[0].grade, maxLevel: zones[0].level, zones: zones };
  };

  function heightClass(h) {
    if (h > 10) return '10m超';
    if (h >= 10) return '10m';
    if (h >= 5) return '5m';
    if (h >= 3) return '3m';
    if (h >= 1) return '1m';
    if (h >= 0.2) return '0.2m';
    return '0.2m未満';
  }

  /* ---------------- 一括実行 ---------------- */
  Engine.prototype.simulate = function (src, options) {
    options = options || {};
    var duration = options.duration || 240;
    var dt = options.dt || 1.0;
    var rng = mulberry32(options.seed || 12345);

    var field = this.intensityField(src, this.residual(mulberry32((options.seed || 12345) + 977)));
    var tl = this.timeline(field, src, duration, dt);
    var finals = new Float32Array(field.intensity.length);
    for (var i = 0; i < finals.length; i++) finals[i] = global.Util.roundIntensity(field.intensity[i]);

    var maxI = -3, maxIdx = 0;
    for (i = 0; i < finals.length; i++) if (finals[i] > maxI) { maxI = finals[i]; maxIdx = i; }

    return {
      source: {
        lat: src.lat, lon: src.lon, depth: src.depth, magnitude: src.magnitude,
        kind: src.kind, strike: src.strike, dip: src.dip, rake: src.rake,
        region: this.regions.nameAt(src.lat, src.lon),
        maxIntensity: maxI, maxShindo: global.Util.shindoClass(maxI),
        maxStation: this.stations.name[maxIdx],
        fault: field.dim
      },
      timeline: { dt: dt, count: tl.nt, duration: duration },
      realtime: tl.data,
      final: finals,
      tp: field.tp, ts: field.ts,
      eew: options.eew === false ? [] : this.eewReports(field, src),
      aftershocks: options.aftershocks === false ? []
        : this.aftershocks(src, options.aftershockDays || 3, 3.5, rng),
      tsunami: options.tsunami === false ? null : this.tsunami(src)
    };
  };

  /* 決定論的な擬似乱数 (シードから再現可能) */
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  global.Engine = Engine;
  global.mulberry32 = mulberry32;
})(window);
