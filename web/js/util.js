/* 共通ユーティリティ: 色スケール・震度表記・数値整形・データ復号 */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------------
   * リアルタイム震度のカラースケール
   * 強震モニタと同様に、計測震度 -3 〜 7 を連続的な色で表す。
   * ---------------------------------------------------------------- */
  /* リアルタイム震度の連続配色 (強震モニタ風)。
   * 揺れていない観測点も濃い青で塗り、観測点網が常に見えるようにする。 */
  var RT_STOPS = [
    [-3.0, [ 25,  46, 158]], [-2.5, [ 26,  50, 168]], [-2.0, [ 27,  55, 178]],
    [-1.5, [ 28,  62, 188]], [-1.0, [ 30,  74, 198]], [-0.5, [ 34,  92, 206]],
    [ 0.0, [ 44, 116, 212]], [ 0.5, [ 56, 140, 222]], [ 1.0, [ 63, 143, 216]],
    [ 1.5, [ 66, 176, 200]], [ 2.0, [ 70, 201, 160]], [ 2.5, [116, 214, 122]],
    [ 3.0, [217, 224,  74]], [ 3.5, [231, 200,  60]], [ 4.0, [242, 148,  31]],
    [ 4.5, [224,  58,  42]], [ 5.0, [194,  32,  42]], [ 5.5, [156,  16,  48]],
    [ 6.0, [122,  10,  68]], [ 6.5, [ 94,  10,  94]], [ 7.0, [128,  20, 128]]
  ];

  /* 震度階級カラー (地図上の円マーカー・区域の塗り分け・凡例で共通) */
  /* 震度の配色。地点のタイル・区域の塗りつぶし・凡例で共通に使う。 */
  var SHINDO_COLORS = {
    '0':   '#5b6472', '1': '#2d8ad4', '2': '#3ec9b2', '3': '#f2d64c',
    '4':   '#f5a33c', '5弱': '#ef4132', '5強': '#d8213f',
    '6弱': '#b21a6c', '6強': '#a11fa4', '7':  '#6d0f8a'
  };
  var SHINDO_ORDER = ['0', '1', '2', '3', '4', '5弱', '5強', '6弱', '6強', '7'];

  /* タイルやバッジ用の短縮表記 (5弱 -> 5−、5強 -> 5+)。
   * 2 文字目は肩付きの記号として小さく上に描く。 */
  var SHINDO_SHORT = {
    '0': '0', '1': '1', '2': '2', '3': '3', '4': '4',
    '5弱': '5−', '5強': '5+', '6弱': '6−', '6強': '6+', '7': '7'
  };

  /* 文字色: 濃い背景の階級は白、明るい階級は黒 */
  var SHINDO_TEXT = {
    '0': '#ffffff', '1': '#ffffff', '2': '#101010', '3': '#101010',
    '4': '#101010', '5弱': '#ffffff', '5強': '#ffffff',
    '6弱': '#ffffff', '6強': '#ffffff', '7': '#ffffff'
  };

  function lerp(a, b, t) { return a + (b - a) * t; }

  /* 計測震度 -> [r,g,b] */
  function interpolate(stops, v) {
    if (!isFinite(v)) v = stops[0][0];
    if (v <= stops[0][0]) return stops[0][1];
    var last = stops[stops.length - 1];
    if (v >= last[0]) return last[1];
    for (var i = 1; i < stops.length; i++) {
      if (v <= stops[i][0]) {
        var a = stops[i - 1], b = stops[i];
        var t = (v - a[0]) / (b[0] - a[0]);
        return [
          Math.round(lerp(a[1][0], b[1][0], t)),
          Math.round(lerp(a[1][1], b[1][1], t)),
          Math.round(lerp(a[1][2], b[1][2], t))
        ];
      }
    }
    return last[1];
  }

  function realtimeRGB(v) { return interpolate(RT_STOPS, isFinite(v) ? v : -3); }

  /* ---------------- 常時微動 ----------------
   * 観測点は揺れていないときも交通・風・波・工場などの微動を拾っており、
   * その大きさは場所によって二桁ほど違う。強震モニタの平常時の画面が
   * 一様な青ではなく、青のなかに緑や黄緑がまだらに混じって見えるのは
   * これによる。観測点ごとに決まった値なので、座標のハッシュから作る。
   *
   * PGA の対数正規分布とし、軟弱地盤ほど微動が大きいものとして
   * 増幅率で中央値をずらす。
   */
  var AMBIENT_MEDIAN_LOG10 = -1.48;  // 中央値 0.033 gal
  var AMBIENT_SIGMA_LOG10 = 0.60;
  var AMBIENT_AVS30_SLOPE = 0.85;
  var AMBIENT_MIN = 0.008, AMBIENT_MAX = 5.0;  // gal

  function fmix32(x) {
    x = x | 0;
    x = Math.imul(x ^ (x >>> 16), 0x85EBCA6B);
    x = Math.imul(x ^ (x >>> 13), 0xC2B2AE35);
    return (x ^ (x >>> 16)) >>> 0;
  }

  /* 座標から決まる標準正規乱数 (同じ観測点はいつも同じ値) */
  function siteNormal(lat, lon, salt) {
    var a = Math.imul(Math.round(lat * 1000) | 0, 0x8DA6B343);
    var b = Math.imul(Math.round(lon * 1000) | 0, 0xD8163841);
    var key = ((a ^ b) ^ salt) | 0;
    var u1 = Math.max(fmix32(key) / 4294967296, 1 / 4294967296);
    var u2 = fmix32((key ^ 0x2545F491) | 0) / 4294967296;
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /* 常時微動は時間とともに揺らぐ。交通や風は一定ではないので、
   * 強震モニタの平常時の画面は絶えずちらついて見える。
   * 観測点ごとの種と時刻から、なめらかに変わる倍率を作る。 */
  var FLICKER_LOG10 = 0.32;     // 揺らぎの幅 (log10 gal)
  var FLICKER_SLOW = 0.45;      // ゆっくりした成分 [Hz]
  var FLICKER_FAST = 1.6;       // 速い成分 [Hz]

  /* 観測点を区別するための種 (座標から決まる) */
  function siteSeed(lat, lon) {
    var a = Math.imul(Math.round(lat * 1000) | 0, 0x8DA6B343);
    var b = Math.imul(Math.round(lon * 1000) | 0, 0xD8163841);
    return (a ^ b) | 0;
  }

  /* 整数点の値を滑らかにつないだ雑音 (0-1、平均 0.5) */
  function smoothNoise(seed, x) {
    var i = Math.floor(x), f = x - i;
    var a = fmix32((seed ^ Math.imul(i, 0x27D4EB2F)) | 0) / 4294967296;
    var b = fmix32((seed ^ Math.imul(i + 1, 0x27D4EB2F)) | 0) / 4294967296;
    return a + (b - a) * (f * f * (3 - 2 * f));
  }

  /* 常時微動に掛ける倍率 */
  function ambientFlicker(seed, t) {
    var n = 0.7 * smoothNoise(seed, t * FLICKER_SLOW)
          + 0.3 * smoothNoise(seed ^ 0x5BF03635, t * FLICKER_FAST);
    return Math.pow(10, FLICKER_LOG10 * (n - 0.5) * 2);
  }

  /* 観測点の常時微動の大きさ [gal] (中央値) */
  function ambientPGA(lat, lon, avs30) {
    var v = Math.min(1500, Math.max(100, avs30 || 400));
    var arv = Math.pow(10, 1.83 - 0.66 * Math.log10(v));
    var logPga = AMBIENT_MEDIAN_LOG10
               + AMBIENT_AVS30_SLOPE * Math.log10(arv)
               + AMBIENT_SIGMA_LOG10 * siteNormal(lat, lon, 0x51ED270B);
    return Math.min(AMBIENT_MAX, Math.max(AMBIENT_MIN, Math.pow(10, logPga)));
  }

  /* 計測震度 I = 2*log10(a) + 0.94 の関係で読み替える */
  function pgaFromIntensity(v) { return Math.pow(10, (v - 0.94) / 2); }

  /* ---------------- PGA の配色 (強震モニタの地表最大加速度と同じ) ----------------
   * 0.01 gal の濃い青から 1000 gal の暗い赤まで、対数で並べる。 */
  var PGA_STOPS = [
    [-2.0, [ 22,  44, 190]], [-1.7, [ 22,  74, 226]], [-1.3, [ 32, 132, 240]],
    [-1.0, [ 40, 192, 236]], [-0.7, [ 40, 220, 192]], [-0.3, [ 44, 220, 112]],
    [ 0.0, [ 92, 226,  70]], [ 0.3, [172, 230,  58]], [ 0.7, [230, 230,  50]],
    [ 1.0, [250, 210,  40]], [ 1.3, [250, 170,  40]], [ 1.7, [250, 130,  30]],
    [ 2.0, [245,  92,  30]], [ 2.3, [235,  50,  35]], [ 2.7, [210,  30,  42]],
    [ 3.0, [168,  20,  44]]
  ];
  var PGA_TICKS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];

  function pgaRGB(gal) {
    return interpolate(PGA_STOPS, Math.log10(Math.max(gal, 1e-4)));
  }
  function pgaCSS(gal) {
    var c = pgaRGB(gal);
    return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
  }

  function realtimeCSS(v) {
    var c = realtimeRGB(v);
    return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
  }

  /* 計測震度 -> 震度階級 */
  function shindoClass(v) {
    if (!isFinite(v)) return '0';
    if (v >= 6.5) return '7';
    if (v >= 6.0) return '6強';
    if (v >= 5.5) return '6弱';
    if (v >= 5.0) return '5強';
    if (v >= 4.5) return '5弱';
    if (v >= 3.5) return '4';
    if (v >= 2.5) return '3';
    if (v >= 1.5) return '2';
    if (v >= 0.5) return '1';
    return '0';
  }

  function shindoColor(name) { return SHINDO_COLORS[name] || SHINDO_COLORS['0']; }
  function shindoTextColor(name) { return SHINDO_TEXT[name] || '#ffffff'; }
  function shindoIndex(name) { return SHINDO_ORDER.indexOf(name); }
  function shindoShort(name) { return SHINDO_SHORT[name] || name; }
  /* 計測震度 -> 短縮表記 */
  function shortLabel(v) { return shindoShort(shindoClass(v)); }

  /* 計測震度 -> PGV [cm/s] (藤本・翠川 2005 の逆換算) */
  function pgvFromIntensity(v) { return Math.pow(10, (v - 2.68) / 1.72); }

  /* 長周期地震動階級 (絶対速度応答スペクトルの目安 Sva [cm/s] から) */
  function lgIntensityClass(sva) {
    if (sva >= 100) return 4;
    if (sva >= 50) return 3;
    if (sva >= 15) return 2;
    if (sva >= 5) return 1;
    return 0;
  }
  /* PGV [cm/s] から長周期地震動階級を概算する */
  function lgClassFromPgv(pgv) { return lgIntensityClass(pgv * 1.6); }

  /* 告示どおりの丸め (小数第3位を四捨五入し第2位を切り捨て) */
  function roundIntensity(v) {
    if (!isFinite(v)) return -3;
    var two = Math.round(v * 100) / 100;
    return Math.floor(two * 10) / 10;
  }

  /* ------------------------------------------------------------------
   * 数値・時刻の整形
   * ---------------------------------------------------------------- */
  function pad(n, w) {
    var s = String(Math.abs(Math.floor(n)));
    while (s.length < (w || 2)) s = '0' + s;
    return (n < 0 ? '-' : '') + s;
  }

  function formatClock(date) {
    return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
  }
  function formatDate(date) {
    return date.getFullYear() + '/' + pad(date.getMonth() + 1) + '/' + pad(date.getDate());
  }
  function formatHM(date) {
    return pad(date.getMonth() + 1) + '/' + pad(date.getDate()) + ' ' +
           pad(date.getHours()) + ':' + pad(date.getMinutes());
  }
  function formatStamp(date) {
    return date.getFullYear() + '/' + pad(date.getMonth() + 1) + '/' + pad(date.getDate()) +
           ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  }
  function formatElapsed(sec) {
    var sign = sec < 0 ? '-' : '+';
    var a = Math.abs(sec);
    return sign + a.toFixed(1) + 's';
  }
  function formatDuration(sec) {
    var m = Math.floor(sec / 60), s = Math.round(sec % 60);
    if (m <= 0) return s + '秒';
    return m + '分' + (s ? s + '秒' : '');
  }
  function formatMagnitude(m) { return 'M' + Number(m).toFixed(1); }
  /* 深さの表記。気象庁と同じで、10km に満たないものは数字を出さず
   * 「ごく浅い」とする (10km ちょうどは 10km と出す)。 */
  function formatDepth(km) {
    if (km < 10) return 'ごく浅い';
    return Math.round(km) + 'km';
  }

  /* ------------------------------------------------------------------
   * base64 で埋め込まれた型付き配列の復号
   * ---------------------------------------------------------------- */
  function decodeBase64(b64) {
    var bin = global.atob(b64);
    var len = bin.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  function decodeInt8(b64) { return new Int8Array(decodeBase64(b64).buffer); }
  function decodeInt16(b64) { return new Int16Array(decodeBase64(b64).buffer); }

  /* 地理計算 (描画用の簡易版) */
  var R_EARTH = 6371.0088;
  function toRad(d) { return d * Math.PI / 180; }
  function haversine(lat1, lon1, lat2, lon2) {
    var p1 = toRad(lat1), p2 = toRad(lat2);
    var dp = p2 - p1, dl = toRad(lon2 - lon1);
    var h = Math.sin(dp / 2) * Math.sin(dp / 2) +
            Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  global.Util = {
    realtimeRGB: realtimeRGB,
    realtimeCSS: realtimeCSS,
    ambientPGA: ambientPGA,
    ambientFlicker: ambientFlicker,
    siteSeed: siteSeed,
    pgaFromIntensity: pgaFromIntensity,
    pgaCSS: pgaCSS,
    pgaRGB: pgaRGB,
    pgaTicks: PGA_TICKS,
    shindoClass: shindoClass,
    shindoColor: shindoColor,
    shindoTextColor: shindoTextColor,
    shindoIndex: shindoIndex,
    shindoShort: shindoShort,
    shortLabel: shortLabel,
    shindoOrder: SHINDO_ORDER,
    shindoColors: SHINDO_COLORS,
    pgvFromIntensity: pgvFromIntensity,
    lgIntensityClass: lgIntensityClass,
    lgClassFromPgv: lgClassFromPgv,
    roundIntensity: roundIntensity,
    pad: pad,
    formatClock: formatClock,
    formatDate: formatDate,
    formatHM: formatHM,
    formatStamp: formatStamp,
    formatElapsed: formatElapsed,
    formatDuration: formatDuration,
    formatMagnitude: formatMagnitude,
    formatDepth: formatDepth,
    decodeInt8: decodeInt8,
    decodeInt16: decodeInt16,
    haversine: haversine,
    clamp: clamp,
    RT_STOPS: RT_STOPS
  };
})(window);
