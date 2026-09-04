/* 共通ユーティリティ: 色スケール・震度表記・数値整形・データ復号 */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------------
   * リアルタイム震度のカラースケール
   * 強震モニタと同様に、計測震度 -3 〜 7 を連続的な色で表す。
   * ---------------------------------------------------------------- */
  var RT_STOPS = [
    [-3.0, [ 10,  14,  46]], [-2.5, [ 12,  20,  74]], [-2.0, [ 14,  26, 104]],
    [-1.5, [ 16,  34, 142]], [-1.0, [ 18,  44, 182]], [-0.5, [ 20,  60, 224]],
    [ 0.0, [ 16,  92, 246]], [ 0.5, [ 12, 132, 250]], [ 1.0, [  8, 168, 246]],
    [ 1.5, [  6, 200, 232]], [ 2.0, [ 10, 220, 200]], [ 2.5, [ 20, 214, 146]],
    [ 3.0, [ 44, 200,  70]], [ 3.5, [110, 214,  36]], [ 4.0, [186, 228,  28]],
    [ 4.5, [242, 226,  30]], [ 5.0, [252, 190,  22]], [ 5.5, [252, 146,  16]],
    [ 6.0, [250,  96,  20]], [ 6.5, [238,  38,  30]], [ 7.0, [200,  16,  60]]
  ];

  /* 震度階級カラー (地図上の円マーカーと凡例で共通) */
  var SHINDO_COLORS = {
    '0':   '#4c5a6e', '1': '#2b6fd0', '2': '#17b3c8', '3': '#3fbf6f',
    '4':   '#f5a623', '5弱': '#f06a1e', '5強': '#e0341c',
    '6弱': '#c01818', '6強': '#8f0f0f', '7':  '#7a0a5a'
  };
  var SHINDO_ORDER = ['0', '1', '2', '3', '4', '5弱', '5強', '6弱', '6強', '7'];

  /* 円マーカーやバッジ用の短縮表記 (5弱 -> 5-、5強 -> 5+) */
  var SHINDO_SHORT = {
    '0': '0', '1': '1', '2': '2', '3': '3', '4': '4',
    '5弱': '5-', '5強': '5+', '6弱': '6-', '6強': '6+', '7': '7'
  };

  /* 文字色: 濃い背景の階級は白、明るい階級は黒 */
  var SHINDO_TEXT = {
    '0': '#ffffff', '1': '#ffffff', '2': '#06232b', '3': '#05240f',
    '4': '#2b1a00', '5弱': '#ffffff', '5強': '#ffffff',
    '6弱': '#ffffff', '6強': '#ffffff', '7': '#ffffff'
  };

  function lerp(a, b, t) { return a + (b - a) * t; }

  /* 計測震度 -> [r,g,b] */
  function realtimeRGB(v) {
    if (!isFinite(v)) v = -3;
    if (v <= RT_STOPS[0][0]) return RT_STOPS[0][1];
    var last = RT_STOPS[RT_STOPS.length - 1];
    if (v >= last[0]) return last[1];
    for (var i = 1; i < RT_STOPS.length; i++) {
      if (v <= RT_STOPS[i][0]) {
        var a = RT_STOPS[i - 1], b = RT_STOPS[i];
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
  function formatDepth(km) {
    if (km <= 10) return 'ごく浅い〜' + Math.round(km) + 'km';
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
