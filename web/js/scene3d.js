/* 揺れ方の 3D 体験
 *
 * 地震の揺れを、部屋やオフィス、住宅街、高層ビルといった場所の中から
 * 見たらどうなるかを描く。地図の震度だけでは分からない「その場の揺れ方」
 * を掴むためのもので、建物の被害を予測するものではない。
 *
 * 描画は外部のライブラリを使わず、キャンバスに四角形を奥から順に塗る
 * だけの簡単なものにしてある (単一 HTML に収めるため)。
 */
(function (global) {
  'use strict';

  var U = null;   // global.Util (読み込み順の都合で使うときに取る)

  /* ================= 揺れの合成 =================
   *
   * リアルタイム震度の時系列は「その時刻の揺れの大きさ」しか持っていない。
   * 3D で揺らすには実際に振動する波形が要るので、震度から決まる速度振幅に
   * 合わせて、その場で帯域制限の揺らぎを作る。
   *
   *   計測震度 I -> 最大速度 PGV = 10^((I - 2.68) / 1.72)   [cm/s]
   *   変位の振幅 A = PGV / (2*pi*f)                         [cm]
   *
   * f (卓越振動数) は地震の規模と震源距離で決まる。大きい地震・遠い場所
   * ほどゆっくり揺れる。 */
  var COMP = 7;           // 重ね合わせる正弦波の数

  function ShakeModel(seed) {
    this.phase = new Float64Array(COMP * 3);
    this.weight = new Float64Array(COMP);
    var x = seed || 1;
    var sum = 0;
    for (var i = 0; i < COMP; i++) {
      for (var c = 0; c < 3; c++) {
        x = Math.sin(x * 91.7 + 4.13 + i * 7.7 + c * 3.1) * 43758.5453;
        this.phase[i * 3 + c] = (x - Math.floor(x)) * Math.PI * 2;
      }
      // 中心の振動数のまわりに山なりの重み
      var d = (i - (COMP - 1) / 2) / ((COMP - 1) / 2);
      this.weight[i] = Math.exp(-1.6 * d * d);
      sum += this.weight[i];
    }
    for (i = 0; i < COMP; i++) this.weight[i] /= sum;
    this.freq = 1.6;
  }

  /* 卓越振動数 [Hz]。M が大きく、遠いほど低くなる。 */
  ShakeModel.prototype.setSource = function (magnitude, distanceKm) {
    var m = Math.max(3, Math.min(9.5, magnitude || 6));
    var r = Math.max(5, distanceKm || 50);
    var f = 3.2 * Math.pow(10, -0.13 * (m - 5)) * Math.pow(r / 50, -0.22);
    this.freq = Math.max(0.28, Math.min(3.2, f));
    // 長周期地震動。M8 級の地震では周期 2〜8 秒の揺れが遠くまで届き、
    // 高層ビルをゆっくり大きく揺らす。小さい地震ではほとんど出ない。
    this.longFreq = Math.max(0.10, 0.30 * Math.pow(10, -0.10 * (m - 6)));
    this.longRatio = Math.max(0, Math.min(1.5, (m - 6.4) * 0.55));
    this.longPhase = (m * 3.7 + r * 0.013) % (Math.PI * 2);
  };

  /* 単位振幅の揺れ (-1 〜 1 くらい)。c = 0,1 が水平、2 が上下。 */
  ShakeModel.prototype.wave = function (t, c) {
    var s = 0, f0 = this.freq * (c === 2 ? 1.9 : 1);
    for (var i = 0; i < COMP; i++) {
      var f = f0 * (0.62 + 0.13 * i);
      s += this.weight[i] * Math.sin(2 * Math.PI * f * t + this.phase[i * 3 + c]);
    }
    return s * 1.7;
  };

  /* 計測震度から地面の変位 [m] を返す */
  ShakeModel.prototype.ground = function (t, intensity) {
    var pgv = Math.pow(10, (Math.max(intensity, -3) - 2.68) / 1.72);   // cm/s
    var amp = pgv / (2 * Math.PI * this.freq) / 100;                   // m
    var out = [amp * this.wave(t, 0), amp * this.wave(t, 1) * 0.85,
               amp * this.wave(t, 2) * 0.42];
    // 長周期の成分。同じ速度でも周期が長いぶん変位は大きくなる。
    var lr = this.longRatio || 0;
    if (lr > 0) {
      var la = (pgv * lr * 0.4) / (2 * Math.PI * this.longFreq) / 100;
      var w = 2 * Math.PI * this.longFreq * t;
      out[0] += la * Math.sin(w + this.longPhase);
      out[1] += la * 0.8 * Math.sin(w * 0.94 + this.longPhase + 1.9);
    }
    return out;
  };

  /* ================= 2 次系の応答 =================
   * 建物のゆっくりした揺れや、体が床の動きに遅れてついていく様子を表す。 */
  function Oscillator(periodS, damping) {
    this.w = 2 * Math.PI / periodS;
    this.z = damping;
    this.x = 0; this.v = 0;
  }

  Oscillator.prototype.step = function (target, dt) {
    // 基部が target だけ動いたときの相対変位を陽的に解く
    var n = Math.max(1, Math.ceil(dt / 0.004));
    var h = dt / n;
    for (var i = 0; i < n; i++) {
      var a = this.w * this.w * (target - this.x) - 2 * this.z * this.w * this.v;
      this.v += a * h;
      this.x += this.v * h;
    }
    return this.x;
  };

  Oscillator.prototype.reset = function () { this.x = 0; this.v = 0; };

  /* ================= 場面 =================
   *
   * 直方体を並べただけの簡単な作り。kind でその物の揺れ方を決める。
   *
   *   fixed  床や壁。建物といっしょに動く
   *   loose  家具や小物。強く揺れるとずれて、さらに強いと倒れる
   *   hang   吊り下げ。振り子として揺れる
   */
  function box(x, y, z, w, h, d, color, kind, opts) {
    var b = { x: x, y: y, z: z, w: w, h: h, d: d, color: color,
              kind: kind || 'fixed' };
    if (opts) for (var k in opts) b[k] = opts[k];
    return b;
  }

  /* 部屋の箱 (床・天井・壁)。中から見るので内側だけ塗る。 */
  function room(w, h, d, floor, wall, ceil) {
    var t = 0.12, S = { shell: 1 };
    return [
      box(0, -t / 2, 0, w, t, d, floor, 'fixed', S),
      box(0, h + t / 2, 0, w, t, d, ceil, 'fixed', S),
      box(0, h / 2, -d / 2 - t / 2, w, h, t, wall, 'fixed', S),
      box(0, h / 2, d / 2 + t / 2, w, h, t, wall, 'fixed', S),
      box(-w / 2 - t / 2, h / 2, 0, t, h, d, wall, 'fixed', S),
      box(w / 2 + t / 2, h / 2, 0, t, h, d, wall, 'fixed', S)
    ];
  }

  var SCENES = {};

  SCENES.living = {
    name: 'リビング', note: '木造住宅の居間から',
    eye: 1.35, camera: [0.3, 1.45, 2.2], yaw: 0.06, pitch: -0.10,
    sky: '#1b2330',
    build: function () {
      var o = room(5.6, 2.5, 5.2, '#8d6a4a', '#cfc4b4', '#e8e4dc');
      o.push(box(-1.2, 0.2, -1.2, 2.0, 0.4, 0.9, '#7c5f52', 'loose', { topple: 6.0 }));   // ソファ座面
      o.push(box(-1.2, 0.62, -1.55, 2.0, 0.45, 0.22, '#8a6a5c', 'loose', { topple: 6.0 }));
      o.push(box(-1.1, 0.36, 0.5, 1.1, 0.06, 0.6, '#a9793f', 'loose', { topple: 5.2 }));  // 座卓
      o.push(box(-1.1, 0.44, 0.5, 0.12, 0.1, 0.12, '#dfe3e8', 'loose', { topple: 4.2, light: 1 }));
      o.push(box(2.2, 1.05, -1.4, 0.45, 2.1, 1.6, '#6d5a48', 'loose', { topple: 4.8 }));  // 本棚
      for (var i = 0; i < 4; i++) {
        o.push(box(2.05, 0.45 + i * 0.5, -1.4, 0.1, 0.34, 1.4, '#c8b394', 'loose',
                   { topple: 4.4, light: 1 }));
      }
      o.push(box(0.2, 0.72, -2.3, 1.3, 0.78, 0.1, '#22262c', 'loose', { topple: 5.0 })); // テレビ
      o.push(box(0.2, 0.18, -2.25, 1.5, 0.36, 0.4, '#5b4a3c', 'fixed'));
      o.push(box(-0.3, 2.18, 0.4, 0.5, 0.16, 0.5, '#f0e6c8', 'hang',
                 { len: 0.34, glow: 1 }));                                              // 吊り照明
      o.push(box(-2.5, 1.3, -2.3, 1.6, 1.2, 0.06, '#2b3a4a', 'fixed', { window: 1 }));  // 窓
      return o;
    }
  };

  SCENES.office = {
    name: 'オフィス', note: '事務室のデスクから',
    eye: 1.2, camera: [0.3, 1.55, 3.5], yaw: 0.04, pitch: -0.12,
    sky: '#1a2130',
    build: function () {
      var o = room(9, 2.7, 8, '#5d6068', '#c9ccd2', '#eceef2');
      for (var r = 0; r < 3; r++) {
        for (var c = 0; c < 3; c++) {
          var x = -2.6 + c * 2.6, z = -2.4 + r * 2.2;
          o.push(box(x, 0.68, z, 1.5, 0.05, 0.75, '#dcd3c4', 'loose', { topple: 6.2 }));
          o.push(box(x - 0.6, 0.33, z, 0.08, 0.66, 0.7, '#8b8f96', 'fixed'));
          o.push(box(x + 0.6, 0.33, z, 0.08, 0.66, 0.7, '#8b8f96', 'fixed'));
          o.push(box(x, 0.94, z - 0.22, 0.56, 0.36, 0.05, '#20242b', 'loose',
                     { topple: 4.6, light: 1 }));                                  // モニタ
          o.push(box(x, 0.45, z + 0.75, 0.5, 0.1, 0.5, '#3a4048', 'loose', { topple: 5.2 }));
          o.push(box(x, 0.8, z + 0.98, 0.5, 0.6, 0.1, '#3a4048', 'loose', { topple: 5.2 }));
        }
      }
      o.push(box(-4.2, 1.0, -3.6, 0.5, 2.0, 1.8, '#7b818a', 'loose', { topple: 4.6 }));
      for (var i = 0; i < 2; i++) {
        o.push(box(-2 + i * 4, 2.62, -1, 1.3, 0.1, 0.3, '#f5f2e6', 'hang',
                   { len: 0.1, glow: 1 }));
      }
      o.push(box(0, 1.5, -4.0, 7.0, 1.5, 0.06, '#2a3b4d', 'fixed', { window: 1 }));
      return o;
    }
  };

  SCENES.kitchen = {
    name: '台所', note: '食器棚のそばで',
    eye: 1.5, camera: [0.9, 1.55, 1.55], yaw: -0.30, pitch: -0.14,
    sky: '#1d2530',
    build: function () {
      var o = room(4.2, 2.4, 4.0, '#9a8f7f', '#d8d2c6', '#efece4');
      o.push(box(-1.3, 0.45, -1.5, 2.2, 0.9, 0.62, '#b9ab93', 'fixed'));            // 流し台
      o.push(box(-1.3, 0.92, -1.5, 2.2, 0.05, 0.66, '#cfd3d6', 'fixed'));
      o.push(box(-1.3, 1.75, -1.72, 2.2, 1.0, 0.36, '#a08b6d', 'loose', { topple: 4.4 })); // 吊戸棚
      o.push(box(1.4, 0.9, -1.4, 0.7, 1.8, 0.7, '#c6ccd2', 'loose', { topple: 4.8 }));     // 冷蔵庫
      for (var i = 0; i < 6; i++) {
        o.push(box(-2.0 + i * 0.28, 1.02, -1.45, 0.16, 0.16, 0.16, '#eef1f4', 'loose',
                   { topple: 3.6, light: 1 }));                                      // 食器
      }
      o.push(box(0.6, 1.05, 0.9, 0.9, 0.06, 0.7, '#a9793f', 'loose', { topple: 5.4 }));
      o.push(box(0, 2.16, 0, 0.44, 0.12, 0.44, '#f3ead0', 'hang', { len: 0.2, glow: 1 }));
      return o;
    }
  };

  SCENES.classroom = {
    name: '教室', note: '学校の教室の後ろから',
    eye: 1.45, camera: [0.2, 1.55, 4.3], yaw: 0.02, pitch: -0.10,
    sky: '#1b2431',
    build: function () {
      var o = room(9, 3.0, 9.5, '#a0865e', '#dcd6c8', '#f0ede4');
      o.push(box(0, 1.5, -4.7, 6.4, 1.3, 0.06, '#2f4a3a', 'fixed'));                 // 黒板
      for (var r = 0; r < 5; r++) {
        for (var c = 0; c < 6; c++) {
          var x = -3.2 + c * 1.28, z = -3.0 + r * 1.5;
          o.push(box(x, 0.7, z, 0.6, 0.04, 0.42, '#c9a978', 'loose', { topple: 5.6 }));
          o.push(box(x, 0.35, z, 0.05, 0.68, 0.38, '#8a8f96', 'fixed'));
          o.push(box(x, 0.42, z + 0.55, 0.4, 0.04, 0.36, '#b08d5e', 'loose', { topple: 5.0 }));
          o.push(box(x, 0.75, z + 0.72, 0.4, 0.5, 0.04, '#b08d5e', 'loose', { topple: 5.0 }));
        }
      }
      for (var i = 0; i < 3; i++) {
        o.push(box(-2.6 + i * 2.6, 2.9, -1, 1.2, 0.1, 0.24, '#f6f3e8', 'hang',
                   { len: 0.12, glow: 1 }));
      }
      o.push(box(4.4, 1.6, 0, 0.06, 1.6, 8.0, '#2e4256', 'fixed', { window: 1 }));
      return o;
    }
  };

  SCENES.store = {
    name: 'コンビニ', note: '商品棚の通路で',
    eye: 1.55, camera: [-0.9, 1.62, 4.3], yaw: 0.10, pitch: -0.05,
    sky: '#1a2028',
    build: function () {
      var o = room(8, 2.8, 9, '#b9bec4', '#dfe3e8', '#f6f7f9');
      for (var s = 0; s < 4; s++) {
        var x = -2.7 + s * 1.8;
        o.push(box(x, 0.9, -1.0, 0.7, 1.8, 5.0, '#8f959c', 'loose', { topple: 4.4 }));
        for (var lv = 0; lv < 4; lv++) {
          for (var j = 0; j < 8; j++) {
            o.push(box(x, 0.42 + lv * 0.44, -3.2 + j * 0.62, 0.62, 0.2, 0.5,
                       ['#d76a4a', '#4a86c8', '#c9b24a', '#5fa46a'][(s + lv + j) % 4],
                       'loose', { topple: 3.4, light: 1 }));
          }
        }
      }
      for (var i = 0; i < 4; i++) {
        o.push(box(-2.7 + i * 1.8, 2.72, 0, 0.3, 0.08, 6.0, '#fbfbf5', 'fixed', { glow: 1 }));
      }
      o.push(box(0, 1.5, 4.4, 7.2, 2.2, 0.06, '#26333f', 'fixed', { window: 1 }));
      return o;
    }
  };

  SCENES.highrise = {
    name: '高層ビル上層階', note: '30 階のオフィスから',
    eye: 1.25, camera: [0.2, 1.55, 3.0], yaw: 0.02, pitch: -0.06,
    sky: '#101826', sway: 4.2,
    build: function () {
      var o = room(9, 2.8, 7, '#5a5f68', '#c4c8ce', '#e9ebef');
      for (var c = 0; c < 3; c++) {
        var x = -2.7 + c * 2.7;
        o.push(box(x, 0.7, -1.0, 1.6, 0.05, 0.8, '#d8cfc0', 'loose', { topple: 6.4 }));
        o.push(box(x - 0.68, 0.34, -1.0, 0.07, 0.68, 0.74, '#8b8f96', 'fixed'));
        o.push(box(x + 0.68, 0.34, -1.0, 0.07, 0.68, 0.74, '#8b8f96', 'fixed'));
        o.push(box(x, 0.96, -1.25, 0.6, 0.38, 0.05, '#20242b', 'loose', { topple: 4.8, light: 1 }));
        o.push(box(x, 0.45, 0.0, 0.5, 0.1, 0.5, '#3a4048', 'loose', { topple: 5.4 }));
      }
      o.push(box(-3.8, 1.1, 2.2, 0.5, 2.2, 1.6, '#7b818a', 'loose', { topple: 4.8 }));
      // 窓の外は夜景。ガラス越しにビルの灯りが並ぶ。
      // 窓の外は夜景。ガラス越しにビルの灯りが並ぶ。
      for (var w = 0; w < 5; w++) {
        // 窓の枠からはみ出さない高さに収める
        var bx = -3.4 + w * 1.7, bh = 1.6 + (w % 3) * 0.5;
        var bz = -9 - (w % 2) * 3;
        o.push(box(bx, bh / 2 + 0.25, bz, 1.5, bh, 1.2, '#243447', 'fixed'));
        for (var fl = 0; fl < 4; fl++) {
          o.push(box(bx, 0.55 + fl * 0.42, bz + 0.58, 1.0, 0.2, 0.05,
                     '#d8c98a', 'fixed', { glow: 0.9 }));
        }
      }
      o.push(box(0, 1.5, -3.5, 8.6, 2.4, 0.02, '#2c4763', 'fixed', { glass: 1 }));
      for (var i = 0; i < 2; i++) {
        o.push(box(-2 + i * 4, 2.72, 0, 1.4, 0.08, 0.3, '#f7f4ea', 'hang',
                   { len: 0.08, glow: 1 }));
      }
      return o;
    }
  };

  SCENES.street = {
    name: '住宅街', note: '通りに立って',
    eye: 1.6, camera: [0, 1.6, 6], yaw: 0, pitch: -0.02, outdoor: true,
    sky: '#243348',
    build: function () {
      var o = [box(0, -0.06, 0, 400, 0.12, 400, '#333941', 'fixed', { shell: 1 })];
      o.push(box(0, 0.005, 0, 6, 0.02, 70, '#4a5058', 'fixed', { shell: 1 }));
      for (var s = -1; s <= 1; s += 2) {
        for (var i = 0; i < 6; i++) {
          var z = -14 + i * 6.5, x = s * 8.5;
          var h = 5.4 + ((i * 7 + s) % 3) * 0.7;
          o.push(box(x, h / 2, z, 6.4, h, 5.6, i % 2 ? '#8d8477' : '#9c8e7c', 'loose',
                     { topple: 6.6, sway: 0.22 }));
          o.push(box(x, h + 0.5, z, 7.0, 1.0, 6.2, '#5a4a42', 'loose',
                     { topple: 6.6, sway: 0.22 }));
          o.push(box(x - s * 3.3, 1.2, z - 1.4, 0.1, 2.4, 1.2, '#e8dfa8', 'fixed', { glow: 1 }));
        }
        for (var p = 0; p < 7; p++) {
          o.push(box(s * 4.2, 3.2, -16 + p * 5.5, 0.22, 6.4, 0.22, '#6b6f76', 'loose',
                     { topple: 7.2, sway: 0.5 }));
          o.push(box(s * 4.2, 6.1, -16 + p * 5.5, 1.6, 0.12, 0.12, '#5e6268', 'loose',
                     { topple: 7.2, sway: 0.5 }));
        }
      }
      o.push(box(-2.3, 0.7, -1.5, 1.7, 1.4, 4.0, '#39424e', 'loose', { topple: 6.8 }));
      return o;
    }
  };

  SCENES.skyline = {
    name: '高層ビル群', note: '外から見上げて',
    eye: 1.6, camera: [6, 1.6, 80], yaw: -0.05, pitch: 0.26, outdoor: true,
    sky: '#1d2a40',
    build: function () {
      var o = [box(0, -0.06, 0, 900, 0.12, 900, '#2f353e', 'fixed', { shell: 1 })];
      var spec = [[-16, -6, 9, 46, 3.6], [-4, -14, 11, 68, 5.0], [10, -4, 8, 38, 3.0],
                  [20, -18, 12, 82, 5.8], [-26, -22, 10, 54, 4.2], [2, -30, 14, 96, 6.4]];
      for (var i = 0; i < spec.length; i++) {
        var s = spec[i];
        var floors = Math.round(s[3] / 3.4);
        for (var f = 0; f < floors; f++) {
          o.push(box(s[0], 1.7 + f * 3.4, s[1], s[2], 3.2, s[2] * 0.8,
                     f % 2 ? '#5b6472' : '#525b68', 'loose',
                     { topple: 99, sway: (f + 1) / floors, swayT: s[4], glow: f % 3 === 0 ? 0.5 : 0 }));
        }
      }
      return o;
    }
  };

  var SCENE_ORDER = ['living', 'office', 'kitchen', 'classroom', 'store',
                     'highrise', 'street', 'skyline'];

  /* ================= 描画 ================= */
  function Scene3D(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.shake = new ShakeModel(20260101);
    this.body = [new Oscillator(0.55, 0.45), new Oscillator(0.55, 0.45),
                 new Oscillator(0.4, 0.5)];
    this.building = [new Oscillator(4.0, 0.03), new Oscillator(4.0, 0.03)];
    this.pend = [];
    this.setScene('living');
    this.lastT = 0;
  }

  Scene3D.prototype.setScene = function (key) {
    U = U || global.Util;
    this.key = SCENES[key] ? key : 'living';
    var def = SCENES[this.key];
    this.def = def;
    this.objects = def.build();
    this.yaw = def.yaw; this.pitch = def.pitch;
    this.camBase = def.camera.slice();
    var T = def.sway || 4.0;
    this.building[0] = new Oscillator(T, 0.05);
    this.building[1] = new Oscillator(T * 1.06, 0.05);
    // 高層ビル群のように棟ごとに周期が違うものは、棟ごとに別の応答を持つ
    this.towers = {};
    var self = this;
    this.objects.forEach(function (b) {
      if (!b.swayT || self.towers[b.swayT]) return;
      self.towers[b.swayT] = [new Oscillator(b.swayT, 0.05),
                              new Oscillator(b.swayT * 1.05, 0.05)];
    });
    this.pend = this.objects.map(function (b) {
      return b.kind === 'hang' ? [new Oscillator(2 * Math.PI * Math.sqrt((b.len || 0.3) / 9.8), 0.02),
                                  new Oscillator(2 * Math.PI * Math.sqrt((b.len || 0.3) / 9.8) * 1.03, 0.02)]
                               : null;
    });
    this.reset();
  };

  Scene3D.prototype.reset = function () {
    this.body.forEach(function (o) { o.reset(); });
    this.building.forEach(function (o) { o.reset(); });
    this.pend.forEach(function (p) { if (p) { p[0].reset(); p[1].reset(); } });
    var tw = this.towers || {};
    for (var k in tw) { tw[k][0].reset(); tw[k][1].reset(); }
    this.objects.forEach(function (b) {
      b._sx = 0; b._sz = 0; b._tp = 0; b._dy = 0; b._wx = 0; b._wz = 0;
    });
    this.lastT = 0;
  };

  Scene3D.prototype.setSource = function (magnitude, distanceKm) {
    this.shake.setSource(magnitude, distanceKm);
  };

  /* 1 コマ進める。intensity は今の計測震度。 */
  /* 建物のたわみの上限 [m]。設計上、最上部のずれは高さの 1/100 程度に
   * 収まるように作られている。長周期地震動と共振してもこれを越えない。 */
  var MAX_DRIFT = 1.1;

  function clampDrift(x) {
    return Math.max(-MAX_DRIFT, Math.min(MAX_DRIFT, x));
  }

  Scene3D.prototype.update = function (t, intensity, dt) {
    var g = this.shake.ground(t, intensity);
    // 建物のゆっくりした揺れ (高層ビルで効く)
    var swayX = clampDrift(this.building[0].step(g[0], dt) - g[0]);
    var swayZ = clampDrift(this.building[1].step(g[1], dt) - g[1]);
    this.sway = [swayX, swayZ];
    // 床の動き = 地面 + 建物のたわみ
    var fx = g[0] + swayX, fz = g[1] + swayZ, fy = g[2];
    this.floor = [fx, fy, fz];
    // 体は床の動きに遅れてついていく。この差が「部屋が揺れて見える」量。
    this.cam = [this.body[0].step(fx, dt), this.body[2].step(fy, dt),
                this.body[1].step(fz, dt)];
    this.intensity = intensity;

    var strong = Math.max(0, intensity - 3.0);
    for (var i = 0; i < this.objects.length; i++) {
      var b = this.objects[i];
      if (b.kind === 'loose') {
        // 震度 4 を越えたあたりからずれ始める。重い物ほど動きにくい。
        var slip = Math.max(0, intensity - (b.topple || 5) + 1.6) * 0.045 * (1 - b._tp);
        b._sx = slip * this.shake.wave(t * 0.8 + i, 0);
        b._sz = slip * this.shake.wave(t * 0.8 + i, 1);
        if (b.topple && intensity >= b.topple) b._tp = Math.min(1, b._tp + dt * 1.6);
        if (b.light && b._tp > 0) {
          // 棚の上の小物は落ちて床に散らばる
          var fall = Math.min(1, b._tp * 1.8);
          b._dy = -fall * Math.max(0, b.y - b.h * 0.6);
          b._sx += fall * 0.5 * this.shake.wave(i * 3.3, 0);
          b._sz += fall * 0.5 * this.shake.wave(i * 3.3, 1);
        }
      } else if (b.kind === 'hang') {
        var p = this.pend[i];
        b._sx = p[0].step(fx, dt) - fx;
        b._sz = p[1].step(fz, dt) - fz;
      }
      if (b.sway) {
        // 棟ごとの周期があればそちら、無ければこの建物の応答を使う
        var sx2 = swayX, sz2 = swayZ;
        if (b.swayT && this.towers[b.swayT]) {
          var tw2 = this.towers[b.swayT];
          if (tw2._t !== t) {
            tw2._x = clampDrift(tw2[0].step(g[0], dt) - g[0]);
            tw2._z = clampDrift(tw2[1].step(g[1], dt) - g[1]);
            tw2._t = t;
          }
          sx2 = tw2._x; sz2 = tw2._z;
        }
        b._wx = sx2 * b.sway; b._wz = sz2 * b.sway;
      }
    }
    this.lastT = t;
    this.strong = strong;
  };

  /* ---- 投影 ---- */
  var NEAR = 0.16;

  Scene3D.prototype.project = function (p, out) {
    var c = this.cam, cy = Math.cos(-this.yaw), sy = Math.sin(-this.yaw);
    var x = p[0] - (this.camBase[0] + c[0]);
    var y = p[1] - (this.camBase[1] + c[1]);
    var z = p[2] - (this.camBase[2] + c[2]);
    var x1 = x * cy - z * sy, z1 = x * sy + z * cy;
    var cp = Math.cos(-this.pitch), sp = Math.sin(-this.pitch);
    var y1 = y * cp - z1 * sp, z2 = y * sp + z1 * cp;
    out[0] = x1; out[1] = y1; out[2] = -z2;
    return out;
  };

  function clipNear(poly) {
    var out = [];
    for (var i = 0; i < poly.length; i++) {
      var a = poly[i], b = poly[(i + 1) % poly.length];
      var ain = a[2] >= NEAR, bin = b[2] >= NEAR;
      if (ain) out.push(a);
      if (ain !== bin) {
        var s = (NEAR - a[2]) / (b[2] - a[2]);
        out.push([a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, NEAR]);
      }
    }
    return out;
  }

  /* 頂点の並びは c の各ビットが x, y, z の +/- を表す。
   * 面はそれを一周する順に並べる (たすき掛けにならないように)。 */
  var FACES = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1],
               [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
  var NORMALS = [[0, 0, -1], [0, 0, 1], [0, -1, 0], [0, 1, 0], [-1, 0, 0], [1, 0, 0]];

  function shade(color, k) {
    var r = parseInt(color.slice(1, 3), 16), g = parseInt(color.slice(3, 5), 16),
        b = parseInt(color.slice(5, 7), 16);
    r = Math.round(Math.min(255, r * k)); g = Math.round(Math.min(255, g * k));
    b = Math.round(Math.min(255, b * k));
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  Scene3D.prototype.draw = function () {
    var cv = this.canvas, ctx = this.ctx;
    var rect = cv.getBoundingClientRect();
    if (rect.width < 4) return;
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    if (cv.width !== Math.round(rect.width * dpr)) {
      cv.width = Math.round(rect.width * dpr);
      cv.height = Math.round(rect.height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var W = rect.width, H = rect.height;
    // 室内を見渡せるように広角にする (水平でおよそ 75 度)
    var f = (H / 2) / Math.tan(1.16 / 2);

    // 空 (屋外) か暗がり (屋内)
    var grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, this.def.sky);
    grad.addColorStop(1, this.def.outdoor ? '#0d1420' : '#0b0f16');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    var quads = [];
    var pt = [0, 0, 0];
    for (var i = 0; i < this.objects.length; i++) {
      var b = this.objects[i];
      var ox = (b._sx || 0) + (b._wx || 0), oz = (b._sz || 0) + (b._wz || 0);
      var tilt = (b._tp || 0) * 0.55;
      var hw = b.w / 2, hh = b.h / 2, hd = b.d / 2;
      // 倒れる物は、下の角を軸にして傾ける
      var ct = Math.cos(tilt), st = Math.sin(tilt);
      var v = [];
      for (var c = 0; c < 8; c++) {
        var sx = (c & 1) ? hw : -hw, sy = (c & 2) ? hh : -hh, sz = (c & 4) ? hd : -hd;
        var lx = sx, ly = sy + hh;      // 底面を軸に
        var rx = lx * ct - ly * st, ry = lx * st + ly * ct;
        v.push(this.project([b.x + ox + rx, b.y - hh + (b._dy || 0) + ry,
                             b.z + oz + sz], [0, 0, 0]));
      }
      for (var fi = 0; fi < 6; fi++) {
        var idx = FACES[fi];
        var poly = [v[idx[0]], v[idx[1]], v[idx[2]], v[idx[3]]];
        var cl = clipNear(poly);
        if (cl.length < 3) continue;
        var zsum = 0;
        for (var q = 0; q < cl.length; q++) zsum += cl[q][2];
        var n = NORMALS[fi];
        var lit = 0.42 + 0.58 * Math.max(0, n[1] * 0.75 + n[0] * 0.32 + (-n[2]) * 0.5);
        if (b.glow) lit = Math.max(lit, 1.15);
        // 部屋の殻 (床・壁・天井) は面が大きく、奥行きの平均で並べると
        // 中の物を隠してしまう。常にいちばん先に塗る。
        quads.push({ p: cl, z: zsum / cl.length + (b.shell ? 1e5 : 0),
                     color: shade(b.color, lit), alpha: b.glass ? 0.34 : 1 });
      }
    }
    quads.sort(function (a, b2) { return b2.z - a.z; });

    for (i = 0; i < quads.length; i++) {
      var qd = quads[i], p = qd.p;
      ctx.beginPath();
      ctx.moveTo(W / 2 + f * p[0][0] / p[0][2], H / 2 - f * p[0][1] / p[0][2]);
      for (var j = 1; j < p.length; j++) {
        ctx.lineTo(W / 2 + f * p[j][0] / p[j][2], H / 2 - f * p[j][1] / p[j][2]);
      }
      ctx.closePath();
      ctx.globalAlpha = qd.alpha == null ? 1 : qd.alpha;
      ctx.fillStyle = qd.color;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // 強く揺れているときは視界を少し乱す
    if (this.strong > 0.6) {
      ctx.fillStyle = 'rgba(120, 40, 20, ' + Math.min(0.16, this.strong * 0.03) + ')';
      ctx.fillRect(0, 0, W, H);
    }
  };

  Scene3D.prototype.scenes = function () {
    return SCENE_ORDER.map(function (k) {
      return { key: k, name: SCENES[k].name, note: SCENES[k].note };
    });
  };

  global.Scene3D = Scene3D;
  global.Scene3D.SCENES = SCENES;
  global.Scene3D.ORDER = SCENE_ORDER;
})(window);
