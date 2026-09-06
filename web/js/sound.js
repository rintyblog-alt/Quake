/* 警報音・音声案内
 *
 * 音は 2 系統ある。
 *
 * 1. 差し替え音源  web/sounds/ に置かれたファイルがあればそれを再生する
 * 2. 合成音        ファイルが無いスロットは WebAudio で合成する
 *
 * リポジトリが同梱するのは合成音の生成コードのみで、音声ファイルは
 * Git の管理対象外 (web/sounds/README.md 参照)。
 *
 * 音声案内はブラウザ内蔵の音声合成 (Web Speech API) を用いる。
 * ブラウザの自動再生制限があるため、最初のユーザー操作で unlock() を呼ぶ。
 */
(function (global) {
  'use strict';

  function Sound() {
    this.ctx = null;
    this.enabled = true;
    this.speechEnabled = true;
    this.master = null;
    this.reverb = null;
    this.voice = null;
    this._lastSpoken = '';
    this.buffers = {};        // スロット名 -> AudioBuffer
    this.manifest = null;
    this.slotsReady = false;
  }

  /* 差し替え音源のスロット定義 */
  var SLOTS = [
    'eew_forecast', 'eew_warning', 'eew_update', 'quake_info',
    'tsunami_advisory', 'tsunami_warning', 'tsunami_major',
    'countdown_tick', 'countdown_final'
  ];

  /* web/sounds/ を走査して使える音源を読み込む */
  Sound.prototype.loadSlots = function () {
    var self = this;
    if (!this.ctx) this.unlock();
    if (!this.ctx) return Promise.resolve();

    return fetch('sounds/manifest.json', { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (manifest) {
        self.manifest = manifest;
        // マニフェストが無ければ差し替え音源は使わない (無用な 404 を出さない)
        if (!manifest) return null;
        var jobs = SLOTS.filter(function (slot) { return manifest[slot]; })
          .map(function (slot) { return self.tryLoad(slot, ['sounds/' + manifest[slot]]); });
        return Promise.all(jobs);
      })
      .then(function () {
        self.slotsReady = true;
        var n = Object.keys(self.buffers).length;
        if (n) console.info('[sound] 差し替え音源 ' + n + ' 件を読み込みました');
      });
  };

  Sound.prototype.tryLoad = function (slot, candidates) {
    var self = this;
    var i = 0;
    function attempt() {
      if (i >= candidates.length) return Promise.resolve();
      var url = candidates[i++];
      return fetch(url, { cache: 'force-cache' })
        .then(function (r) { return r.ok ? r.arrayBuffer() : Promise.reject(); })
        .then(function (buf) {
          return new Promise(function (resolve, reject) {
            self.ctx.decodeAudioData(buf, resolve, reject);
          });
        })
        .then(function (audio) { self.buffers[slot] = audio; })
        .catch(function () { return attempt(); });
    }
    return attempt();
  };

  /* 差し替え音源があれば再生して true を返す */
  Sound.prototype.playSlot = function (slot, gain) {
    if (!this.ctx || !this.enabled) return false;
    var buf = this.buffers[slot];
    if (!buf) return false;
    var src = this.ctx.createBufferSource();
    var g = this.ctx.createGain();
    g.gain.value = gain == null ? 1.0 : gain;
    src.buffer = buf;
    src.connect(g); g.connect(this.master);
    src.start();
    return true;
  };

  Sound.prototype.unlock = function () {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();

    this.master = this.ctx.createGain();
    this.master.gain.value = 0.3;

    // 短い残響を付けて機械的な響きを和らげる
    var conv = this.ctx.createConvolver();
    conv.buffer = this.makeImpulse(0.7, 2.6);
    var wet = this.ctx.createGain();
    wet.gain.value = 0.18;

    this.master.connect(this.ctx.destination);
    this.master.connect(conv);
    conv.connect(wet);
    wet.connect(this.ctx.destination);
    this.reverb = conv;

    this.pickVoice();
  };

  Sound.prototype.makeImpulse = function (seconds, decay) {
    var rate = this.ctx.sampleRate;
    var len = Math.floor(rate * seconds);
    var buf = this.ctx.createBuffer(2, len, rate);
    for (var c = 0; c < 2; c++) {
      var d = buf.getChannelData(c);
      for (var i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  };

  Sound.prototype.setEnabled = function (on) {
    this.enabled = !!on;
    if (!on && global.speechSynthesis) global.speechSynthesis.cancel();
  };

  /* ---------------- 音の部品 ---------------- */

  /* 基音に倍音を重ねた鐘のような音 */
  Sound.prototype.chime = function (freq, start, duration, gain, harmonics) {
    if (!this.ctx || !this.enabled) return;
    var t0 = this.ctx.currentTime + start;
    var partials = harmonics || [[1, 1.0], [2, 0.32], [3.01, 0.16], [4.2, 0.07]];
    for (var i = 0; i < partials.length; i++) {
      var osc = this.ctx.createOscillator();
      var g = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq * partials[i][0], t0);
      var peak = (gain == null ? 0.8 : gain) * partials[i][1];
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + 0.008);
      g.gain.exponentialRampToValueAtTime(Math.max(peak * 0.02, 1e-4), t0 + duration);
      osc.connect(g); g.connect(this.master);
      osc.start(t0); osc.stop(t0 + duration + 0.05);
    }
  };

  /* 矩形波系の鋭い音 (警報向け) */
  Sound.prototype.tone = function (freq, start, duration, type, gain) {
    if (!this.ctx || !this.enabled) return;
    var t0 = this.ctx.currentTime + start;
    var osc = this.ctx.createOscillator();
    var g = this.ctx.createGain();
    var filt = this.ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 4200;
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    var peak = gain == null ? 0.7 : gain;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + 0.012);
    g.gain.setValueAtTime(peak, t0 + Math.max(duration - 0.06, 0.02));
    g.gain.linearRampToValueAtTime(0, t0 + duration);
    osc.connect(filt); filt.connect(g); g.connect(this.master);
    osc.start(t0); osc.stop(t0 + duration + 0.03);
  };

  /* 周波数を掃引する音 (津波警報向け) */
  Sound.prototype.sweep = function (f0, f1, start, duration, gain) {
    if (!this.ctx || !this.enabled) return;
    var t0 = this.ctx.currentTime + start;
    var osc = this.ctx.createOscillator();
    var g = this.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(f0, t0);
    osc.frequency.linearRampToValueAtTime(f1, t0 + duration);
    var peak = gain == null ? 0.45 : gain;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + 0.06);
    g.gain.setValueAtTime(peak, t0 + duration - 0.12);
    g.gain.linearRampToValueAtTime(0, t0 + duration);
    var filt = this.ctx.createBiquadFilter();
    filt.type = 'lowpass'; filt.frequency.value = 1400;
    osc.connect(filt); filt.connect(g); g.connect(this.master);
    osc.start(t0); osc.stop(t0 + duration + 0.05);
  };

  /* ---------------- 場面ごとの音 ---------------- */

  /* 緊急地震速報 (予報): 落ち着いた 4 音を 2 回 */
  Sound.prototype.forecast = function () {
    this.unlock();
    if (this.playSlot('eew_forecast')) return;
    var seq = [587.33, 783.99, 698.46, 880.00];   // レ ソ ファ ラ
    for (var rep = 0; rep < 2; rep++) {
      for (var i = 0; i < seq.length; i++) {
        this.chime(seq[i], rep * 1.35 + i * 0.3, 0.7, 0.55);
      }
    }
  };

  /* 緊急地震速報 (警報): 緊迫した 2 音の連打を 4 回 */
  Sound.prototype.warning = function () {
    this.unlock();
    if (this.playSlot('eew_warning')) return;
    for (var i = 0; i < 4; i++) {
      var base = i * 0.56;
      this.chime(932.33, base, 0.34, 0.85, [[1, 1], [2, 0.5], [3, 0.3], [5.4, 0.12]]);
      this.chime(1244.51, base + 0.26, 0.36, 0.85, [[1, 1], [2, 0.5], [3, 0.3], [5.4, 0.12]]);
    }
  };

  /* 津波警報: 低く長い掃引音を繰り返す */
  Sound.prototype.tsunami = function (level) {
    this.unlock();
    var slot = level >= 3 ? 'tsunami_major' : (level >= 2 ? 'tsunami_warning' : 'tsunami_advisory');
    if (this.playSlot(slot)) return;
    var reps = level >= 3 ? 5 : 3;
    for (var i = 0; i < reps; i++) {
      var base = i * 1.0;
      this.sweep(level >= 3 ? 300 : 360, level >= 3 ? 520 : 560, base, 0.72, 0.5);
    }
  };

  /* 続報の通知音 */
  Sound.prototype.blip = function () {
    this.unlock();
    if (this.playSlot('eew_update')) return;
    this.chime(1567.98, 0, 0.16, 0.35, [[1, 1], [2, 0.25]]);
  };

  /* 主要動到達までの秒読み */
  Sound.prototype.tick = function (last) {
    this.unlock();
    if (this.playSlot(last ? 'countdown_final' : 'countdown_tick')) return;
    if (last) this.chime(1760, 0, 0.5, 0.6, [[1, 1], [2, 0.4], [3, 0.2]]);
    else this.tone(1046.5, 0, 0.07, 'square', 0.3);
  };

  /* 地震情報の受信音 */
  Sound.prototype.info = function () {
    this.unlock();
    if (this.playSlot('quake_info')) return;
    this.chime(659.25, 0, 0.45, 0.5);
    this.chime(987.77, 0.18, 0.55, 0.45);
  };

  /* ---------------- 音声案内 ----------------
   *
   * tools/generate_voice.py で作った読み上げ音声が web/sounds/voice/ にあれば、
   * 「地震情報です」「宮城県沖」「最大震度は」「5弱」… と部品をつないで再生する。
   * 無い場合はブラウザ内蔵の音声合成にそのまま戻る。
   */
  Sound.prototype.loadVoice = function () {
    var self = this;
    if (this.voiceIndexLoaded) return Promise.resolve();
    this.voiceIndexLoaded = true;
    if (!this.ctx) this.unlock();

    return fetch('sounds/voice/index.json', { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (payload) {
        if (!payload || !payload.clips) return;
        self.voiceClips = payload.clips;
        self.voiceByText = {};
        Object.keys(payload.clips).forEach(function (key) {
          self.voiceByText[payload.clips[key].text] = key;
        });
        self.voiceBuffers = {};
        console.info('[voice] 読み上げ音声 ' + Object.keys(payload.clips).length + ' 件を検出');
      });
  };

  /* 1 つのクリップを読み込む (一度読んだものは保持する) */
  Sound.prototype.loadClip = function (key) {
    var self = this;
    if (!this.voiceClips || !this.voiceClips[key]) return Promise.resolve(null);
    if (this.voiceBuffers[key]) return Promise.resolve(this.voiceBuffers[key]);
    return fetch('sounds/voice/' + this.voiceClips[key].file, { cache: 'force-cache' })
      .then(function (r) { return r.ok ? r.arrayBuffer() : Promise.reject(); })
      .then(function (buf) {
        return new Promise(function (resolve, reject) {
          self.ctx.decodeAudioData(buf, resolve, reject);
        });
      })
      .then(function (audio) { self.voiceBuffers[key] = audio; return audio; })
      .catch(function () { return null; });
  };

  /* クリップの列を順につないで再生する */
  Sound.prototype.playSequence = function (keys) {
    if (!this.ctx || !this.enabled || !this.voiceClips) return false;
    var self = this;
    var wanted = keys.filter(function (k) { return k && self.voiceClips[k]; });
    if (wanted.length < keys.filter(Boolean).length) return false;   // 欠けていたら使わない

    this.stopVoice();
    var token = (this._voiceToken = (this._voiceToken || 0) + 1);
    Promise.all(wanted.map(function (k) { return self.loadClip(k); })).then(function (buffers) {
      if (token !== self._voiceToken) return;
      if (buffers.some(function (b) { return !b; })) return;
      var at = self.ctx.currentTime + 0.05;
      self._voiceNodes = [];
      buffers.forEach(function (buf) {
        var src = self.ctx.createBufferSource();
        src.buffer = buf;
        src.connect(self.master);
        src.start(at);
        self._voiceNodes.push(src);
        at += buf.duration;
      });
    });
    return true;
  };

  Sound.prototype.stopVoice = function () {
    this._voiceToken = (this._voiceToken || 0) + 1;
    (this._voiceNodes || []).forEach(function (n) {
      try { n.stop(); } catch (e) { /* 既に終わっている */ }
    });
    this._voiceNodes = [];
  };

  /* 震度階級 -> クリップ名 */
  var SHINDO_CLIP = {
    '0': 'shindo_0', '1': 'shindo_1', '2': 'shindo_2', '3': 'shindo_3', '4': 'shindo_4',
    '5弱': 'shindo_5m', '5強': 'shindo_5p', '6弱': 'shindo_6m', '6強': 'shindo_6p', '7': 'shindo_7'
  };
  var HEIGHT_CLIP = {
    '10m超': 'height_10p', '10m': 'height_10', '5m': 'height_5', '3m': 'height_3',
    '1m': 'height_1', '0.2m': 'height_02', '0.2m未満': 'height_slight'
  };
  var DEPTHS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 120, 150, 200, 250, 300, 350, 400, 500, 600, 700];

  function nearestDepth(km) {
    var best = DEPTHS[0];
    for (var i = 1; i < DEPTHS.length; i++) {
      if (Math.abs(DEPTHS[i] - km) < Math.abs(best - km)) best = DEPTHS[i];
    }
    return best;
  }

  Sound.prototype.regionClip = function (name) {
    return this.voiceByText ? this.voiceByText[name] : null;
  };

  /* ---------------- ブラウザ内蔵の音声合成 (代替) ---------------- */
  Sound.prototype.pickVoice = function () {
    if (!global.speechSynthesis) return;
    var self = this;
    function choose() {
      var list = global.speechSynthesis.getVoices() || [];
      for (var i = 0; i < list.length; i++) {
        if (/^ja/i.test(list[i].lang)) { self.voice = list[i]; return; }
      }
    }
    choose();
    if (!this.voice) global.speechSynthesis.onvoiceschanged = choose;
  };

  Sound.prototype.speak = function (text, rate) {
    if (!this.enabled || !this.speechEnabled || !global.speechSynthesis) return;
    if (!text || text === this._lastSpoken) return;
    this._lastSpoken = text;
    var u = new global.SpeechSynthesisUtterance(text);
    u.lang = 'ja-JP';
    u.rate = rate || 1.05;
    if (this.voice) u.voice = this.voice;
    global.speechSynthesis.speak(u);
  };

  Sound.prototype.cancelSpeech = function () {
    this._lastSpoken = '';
    this.stopVoice();
    if (global.speechSynthesis) global.speechSynthesis.cancel();
  };

  /* ---------------- 場面ごとの読み上げ ---------------- */

  /* 緊急地震速報 (合成音声の部品は用意していないため内蔵の音声合成で読む) */
  Sound.prototype.announceEEW = function (report) {
    var head = report.kind === '警報' ? '緊急地震速報、警報。' : '緊急地震速報。';
    var tail = report.kind === '警報'
      ? '強い揺れに警戒してください。' : '揺れに注意してください。';
    this.speak(head + report.region + 'で地震。予想される最大の震度は' +
               report.maxShindo + '。' + tail);
  };

  /* 地震情報 */
  Sound.prototype.announceQuake = function (info) {
    var region = this.regionClip(info.region);
    var shindo = SHINDO_CLIP[info.shindo];
    var mag = 'mag_' + Math.round(Number(info.magnitude) * 10);
    var depth = 'depth_' + nearestDepth(Number(info.depth));

    var seq = ['info_lead', region, 'info_quake', 'info_maxshindo', shindo, 'info_desu',
               'info_depth_lead', depth, 'info_km',
               'info_mag_lead', mag, 'info_mag_tail'];
    if (info.noTsunami) seq.push('info_no_tsunami');
    if (this.playSequence(seq)) return;

    this.speak('地震情報。' + info.region + 'で、最大震度' + info.shindo +
               'の地震がありました。地震の規模はマグニチュード' +
               Number(info.magnitude).toFixed(1) + '、深さ約' +
               Math.round(info.depth) + 'キロメートルです。' +
               (info.noTsunami ? 'この地震による津波の心配はありません。' : ''));
  };

  /* 津波予報 */
  Sound.prototype.announceTsunami = function (forecast) {
    var lead = ['tsunami_forecast', 'tsunami_advisory', 'tsunami_warning', 'tsunami_major'][forecast.maxLevel];
    var evac = ['tsunami_evacuate_forecast', 'tsunami_evacuate_advisory',
                'tsunami_evacuate_warning', 'tsunami_evacuate_major'][forecast.maxLevel];
    var top = forecast.zones.slice(0, 3);
    var seq = [lead];
    for (var i = 0; i < top.length; i++) {
      seq.push(this.regionClip(top[i].name));
      if (i < top.length - 1) seq.push('conj_and');
    }
    seq.push('tsunami_expect');
    seq.push(HEIGHT_CLIP[top[0].heightClass]);
    seq.push('tsunami_expect_tail');
    seq.push(evac);
    if (this.playSequence(seq)) return;

    var names = top.map(function (z) { return z.name; }).join('、');
    var text = {
      3: '大津波警報。ただちに高台や避難ビルへ避難してください。',
      2: '津波警報。ただちに海岸から離れ、高台へ避難してください。',
      1: '津波注意報。海の中や海岸から離れてください。',
      0: '津波予報。若干の海面変動が予想されます。'
    }[forecast.maxLevel] || '津波予報。';
    this.speak(text + '対象は、' + names + 'など。');
  };

  global.Sound = Sound;
})(window);
