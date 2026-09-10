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
    this.channels = {};       // 系統名 -> 今鳴っている音 (重ねずに差し替える)
    this.manifest = null;
    this.slotsReady = false;
    this.bundled = null;
    this.voiceClips = null;   // クリップ名 -> {text, file}
    this.voiceByText = null;  // 読み上げ文 -> クリップ名
    this.voiceBuffers = {};   // ファイル名 -> AudioBuffer
    this.voiceTrim = {};      // ファイル名 -> 前後の無音を除いた範囲
    this.voicePending = {};   // ファイル名 -> 読み込み中の Promise
    this.voiceRate = 1;       // 再生速度 (ネズミ = 1.19)
    this.voiceOut = null;
    this._effectEndsAt = 0;   // 効果音が鳴り終わる時刻 [ctx時間]
  }

  /* 差し替え音源のスロット定義 */
  var SLOTS = [
    'eew_forecast', 'eew_warning', 'eew_update', 'eew_update_major',
    'quake_info', 'quake_info_shindo', 'quake_info_hypo', 'quake_info_detail',
    'tsunami_alarm', 'tsunami_major', 'tsunami_warning',
    'tsunami_advisory', 'tsunami_forecast',
    'countdown_tick', 'countdown_final',
    'eew_chime', 'area_mail',
    'new_int_0', 'new_int_1', 'new_int_2', 'new_int_3',
    'new_int_4', 'new_int_5', 'new_int_6'
  ];

  /* 観測点の反応で鳴らす音。揺れの最大 PGA [gal] が段を越えるたびに
   * 下から順に一度ずつ鳴らす (常時微動は含めない値で判定する)。
   * 段は PGA の配色に合わせてある。
   *
   *   0  微弱      水色にかかるあたり
   *   1  弱い      緑
   *   2  ギリ弱い  濃い緑から黄緑
   *   3  ちょっと強い  黄
   *   4  強い      濃い黄から橙
   *   5  かなり強い    赤
   *   6  極く強い  濃い赤 (最大)
   */
  var DETECT_LEVELS = [0.2, 0.5, 2.0, 5.0, 20.0, 150.0, 500.0];

  /* web/sounds/ を走査して使える音源を読み込む */
  Sound.prototype.loadSlots = function () {
    var self = this;
    if (!this.ctx) this.unlock();
    if (!this.ctx) return Promise.resolve();

    var bundled = global.__BUNDLED_DATA;
    var load = bundled
      ? Promise.resolve(bundled['sounds/manifest.json'] || null)
      : fetch('sounds/manifest.json', { cache: 'no-cache' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .catch(function () { return null; });

    return load
      .then(function (manifest) {
        self.manifest = manifest;
        // マニフェストが無ければ差し替え音源は使わない (無用な 404 を出さない)
        if (!manifest) return null;
        var jobs = SLOTS.filter(function (slot) { return manifest[slot]; })
          .map(function (slot) {
            var rel = 'sounds/' + manifest[slot];
            // バンドル版は data URI が埋め込まれている
            return self.tryLoad(slot, [bundled ? (bundled[rel] || rel) : rel]);
          });
        return Promise.all(jobs);
      })
      .then(function () {
        self.slotsReady = true;
        var n = Object.keys(self.buffers).length;
        if (n) console.info('[sound] 差し替え音源 ' + n + ' 件を読み込みました');
      });
  };

  /* data URI をその場で ArrayBuffer に開く.
   *
   * 単一 HTML の音源は data URI で埋め込んであるが、これを fetch() で読むと
   * connect-src を絞ったページ (Artifact など) で通信とみなされて弾かれ、
   * 音源が 1 つも読めずに合成音へ落ちてしまう。通信を挟まずに開く。 */
  function dataUriToBuffer(uri) {
    var comma = uri.indexOf(',');
    if (comma < 0 || uri.slice(0, comma).indexOf(';base64') < 0) return null;
    var bin = atob(uri.slice(comma + 1));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  Sound.prototype.tryLoad = function (slot, candidates) {
    var self = this;
    var i = 0;
    function attempt() {
      if (i >= candidates.length) return Promise.resolve();
      var url = candidates[i++];
      var direct = url.slice(0, 5) === 'data:' ? dataUriToBuffer(url) : null;
      return (direct ? Promise.resolve(direct)
                     : fetch(url, { cache: 'force-cache' })
                         .then(function (r) { return r.ok ? r.arrayBuffer() : Promise.reject(); }))
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

  /* 差し替え音源があれば再生して true を返す。
   *
   * channel を渡すと、その系統で鳴っている音を止めてから鳴らす。
   * 検知音は段が上がるたび、続報音は報が来るたびに鳴るので、
   * 重ねると混ざって 1 つの音のように聞こえてしまう。 */
  Sound.prototype.playSlot = function (slot, gain, channel, hold, opts) {
    if (!this.ctx || !this.enabled) return false;
    var buf = this.buffers[slot];
    if (!buf) return false;
    var now = this.ctx.currentTime;
    var at = opts && opts.at != null ? Math.max(opts.at, now) : now;
    // 長い音源を途中で切りたいときは maxSeconds を渡す (津波のチャイムなど)
    var span = opts && opts.maxSeconds ? Math.min(opts.maxSeconds, buf.duration) : buf.duration;

    if (channel && !(opts && opts.chain)) {
      // 鳴り始めたばかりの音は、次の音で潰さず最後まで聞かせる
      var cur = this.channels[channel];
      if (cur && now < cur.hold) return true;
      this.stopChannel(channel);
    }
    var src = this.ctx.createBufferSource();
    var g = this.ctx.createGain();
    var vol = gain == null ? 1.0 : gain;
    g.gain.value = vol;
    if (span < buf.duration - 0.02) {
      // 途中で切るのでプツッと鳴らないように終わりを絞る
      g.gain.setValueAtTime(vol, at + Math.max(span - 0.35, 0));
      g.gain.linearRampToValueAtTime(0.0001, at + span);
    }
    src.buffer = buf;
    src.connect(g); g.connect(this.master);
    src.start(at, 0, span);
    this.noteEffect(at - now + span);
    if (channel) {
      var prev = (opts && opts.chain && this.channels[channel]) ? this.channels[channel] : null;
      var parts = prev ? prev.parts.slice() : [];
      parts.push({ src: src, gain: g });
      this.channels[channel] = {
        parts: parts,
        hold: Math.max(prev ? prev.hold : 0,
                       at + Math.min(hold == null ? 0.3 : hold, span))
      };
    }
    return true;
  };

  /* 系統で鳴っている音を短く絞って止める (プツッと切らない) */
  Sound.prototype.stopChannel = function (channel) {
    var cur = this.channels[channel];
    if (!cur) return;
    this.channels[channel] = null;
    var t = this.ctx.currentTime;
    (cur.parts || []).forEach(function (part) {
      try {
        part.gain.gain.cancelScheduledValues(t);
        part.gain.gain.setValueAtTime(part.gain.gain.value, t);
        part.gain.gain.linearRampToValueAtTime(0.0001, t + 0.06);
        part.src.stop(t + 0.07);
      } catch (e) { /* 既に止まっていれば何もしない */ }
    });
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
    if (this.playSlot('eew_forecast', 1.0, 'eew', 1.4)) return;
    this.noteEffect(2.75);
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
    if (this.playSlot('eew_warning', 1.0, 'eew', 1.4)) return;
    // 警報用の音源が無ければ予報用で代える (合成音より近い)
    if (this.playSlot('eew_forecast', 1.0, 'eew', 1.4)) return;
    this.noteEffect(2.3);
    for (var i = 0; i < 4; i++) {
      var base = i * 0.56;
      this.chime(932.33, base, 0.34, 0.85, [[1, 1], [2, 0.5], [3, 0.3], [5.4, 0.12]]);
      this.chime(1244.51, base + 0.26, 0.36, 0.85, [[1, 1], [2, 0.5], [3, 0.3], [5.4, 0.12]]);
    }
  };

  /* 津波の発表音。
   *
   *   大津波警報・津波警報  チャイム (7 秒で切る) -> 種別の音 -> 読み上げ
   *   津波注意報            注意報の音 -> 軽い読み上げ
   *   津波予報              予報の音だけ
   *
   * 音源が無い段は合成音の掃引で代える。 */
  var TSUNAMI_ALARM_SECONDS = 7.0;

  Sound.prototype.tsunami = function (level) {
    this.unlock();
    if (level >= 2) {
      var slot = level >= 3 ? 'tsunami_major' : 'tsunami_warning';
      // チャイムを 7 秒まで鳴らし、そのうしろに種別の音をつなぐ
      var chime = this.playSlot('tsunami_alarm', 1.0, 'tsunami', TSUNAMI_ALARM_SECONDS,
                                { maxSeconds: TSUNAMI_ALARM_SECONDS });
      var at = chime ? this._effectEndsAt : null;
      if (this.playSlot(slot, 1.0, 'tsunami', 1.5, { at: at, chain: chime })) return;
      if (chime) return;                      // 種別の音が無くてもチャイムは鳴らす
    } else if (level === 1) {
      // 注意報の音源 (tsa02) が無いときは予報の音で代える
      if (this.playSlot('tsunami_advisory', 1.0, 'tsunami', 1.5)) return;
      if (this.playSlot('tsunami_forecast', 1.0, 'tsunami', 1.5)) return;
    } else {
      if (this.playSlot('tsunami_forecast', 1.0, 'tsunami', 1.5)) return;
    }
    var reps = level >= 3 ? 5 : 3;
    this.noteEffect(reps * 1.0);
    for (var i = 0; i < reps; i++) {
      this.sweep(level >= 3 ? 300 : 360, level >= 3 ? 520 : 560, i * 1.0, 0.72, 0.5);
    }
  };

  /* ---------------- メディアモードの音 ----------------
   * テレビで流れる緊急地震速報のチャイム。第 1 報は 2 回、続報は 1 回鳴らす。 */
  Sound.prototype.mediaChime = function (times) {
    this.unlock();
    if (!this.ctx || !this.enabled || !this.buffers.eew_chime) return false;
    var buf = this.buffers.eew_chime;
    var n = Math.max(1, times || 1);
    var at = this.ctx.currentTime;
    var ok = false;
    for (var k = 0; k < n; k++) {
      // 2 回目は前の音に続けて鳴らす (系統を潰さないように chain で足す)
      ok = this.playSlot('eew_chime', 1.0, 'eew', buf.duration,
                         { at: at, chain: k > 0 }) || ok;
      at += buf.duration;
    }
    return ok;
  };

  /* エリアメール (緊急速報メール) のブザー */
  Sound.prototype.areaMail = function () {
    this.unlock();
    return this.playSlot('area_mail', 1.0, 'areamail', 1.0);
  };

  Sound.prototype.stopAreaMail = function () {
    if (this.ctx) this.stopChannel('areamail');
  };

  /* 続報の通知音。震源やマグニチュードが大きく動いた報は別の音にする。 */
  Sound.prototype.update = function (major) {
    this.unlock();
    if (major && this.playSlot('eew_update_major', 1.0, 'eew', 0.45)) return;
    if (this.playSlot('eew_update', 1.0, 'eew', 0.45)) return;
    if (major) {
      this.chime(1244.51, 0, 0.22, 0.45, [[1, 1], [2, 0.3]]);
      this.chime(1567.98, 0.16, 0.24, 0.4, [[1, 1], [2, 0.25]]);
      return;
    }
    this.chime(1567.98, 0, 0.16, 0.35, [[1, 1], [2, 0.25]]);
  };

  /* 観測点が反応したときの音 (level は DETECT_LEVELS の段) */
  Sound.prototype.detect = function (level) {
    this.unlock();
    if (this.playSlot('new_int_' + level, 1.0, 'detect', 0.5)) return;
    var f = [660, 740, 880, 988, 1175, 1480, 1865][Math.min(level, 6)];
    this.tone(f, 0, 0.10 + level * 0.015, 'sine', 0.20 + level * 0.05);
  };

  Sound.prototype.detectLevels = function () { return DETECT_LEVELS; };

  /* 主要動到達までの秒読み */
  Sound.prototype.tick = function (last) {
    this.unlock();
    if (this.playSlot(last ? 'countdown_final' : 'countdown_tick')) return;
    if (last) this.chime(1760, 0, 0.5, 0.6, [[1, 1], [2, 0.4], [3, 0.2]]);
    else this.tone(1046.5, 0, 0.07, 'square', 0.3);
  };

  /* 地震情報の受信音。気象庁の 3 段階に対応する。
   *   1 震度速報 (VXSE51)             震度だけが先に出る
   *   2 震源に関する情報 (VXSE52)     震源・規模・深さが決まる
   *   3 震源・震度に関する情報 (VXSE53) 確定 */
  var INFO_SLOTS = ['quake_info_shindo', 'quake_info_hypo', 'quake_info_detail'];

  Sound.prototype.info = function (stage) {
    this.unlock();
    var slot = INFO_SLOTS[(stage || 3) - 1];
    if (slot && this.playSlot(slot, 1.0, 'info', 1.2)) return;
    if (this.playSlot('quake_info', 1.0, 'info', 1.2)) return;
    this.noteEffect(0.85);
    this.chime(659.25, 0, 0.45, 0.5);
    this.chime(987.77, 0.18, 0.55, 0.45);
  };

  /* ---------------- 音声案内 ----------------
   *
   * tools/generate_voice.py が Scratch の音声合成で作った読み上げ音声を
   * web/sounds/voice/ から読み、「地震情報。」「午後」「3時」「47分」…と
   * 部品をつないで鳴らす。声は Scratch の「ネズミ」= アルト (ja-JP/female) を
   * 1.19 倍の速さで再生したもので、その倍率はここで掛ける。
   *
   * 読み上げは必ず効果音が鳴り終わってから始める (noteEffect / _effectEndsAt)。
   */

  var VOICE_GAP = 0.08;            // 部品と部品のあいだ [s]
  var VOICE_PAUSE = 0.28;          // 原稿の句点 (PAUSE) のところで置く間 [s]
  var PAUSE = '。';                 // 部品の列に混ぜると、そこで一拍おく
  var VOICE_AFTER_EFFECT = 0.25;   // 効果音が終わってから読み始めるまで [s]
  var VOICE_GAIN = 0.9;
  var TRIM_THRESHOLD = 0.015;      // 無音とみなす振幅 (最大振幅に対する比)
  var TRIM_MARGIN = 0.03;          // 切り詰めたあとに残す余白 [s]

  /* 効果音の鳴り終わりを控えておく (読み上げはこの後から始める) */
  Sound.prototype.noteEffect = function (seconds) {
    if (!this.ctx) return;
    var end = this.ctx.currentTime + seconds;
    if (end > this._effectEndsAt) this._effectEndsAt = end;
  };

  Sound.prototype.voiceStartTime = function () {
    return Math.max(this.ctx.currentTime + 0.05, this._effectEndsAt + VOICE_AFTER_EFFECT);
  };

  Sound.prototype.loadVoice = function () {
    var self = this;
    if (this.voiceIndexLoaded) return Promise.resolve();
    this.voiceIndexLoaded = true;
    if (!this.ctx) this.unlock();

    var bundled = global.__BUNDLED_DATA;
    this.bundled = bundled || null;
    var load = bundled
      ? Promise.resolve(bundled['sounds/voice/index.json'] || null)
      : fetch('sounds/voice/index.json', { cache: 'no-cache' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .catch(function () { return null; });

    return load.then(function (payload) {
      if (!payload || !payload.clips) return;
      self.voiceClips = payload.clips;
      self.voiceRate = payload.rate || 1;
      self.voiceByText = {};
      Object.keys(payload.clips).forEach(function (key) {
        self.voiceByText[payload.clips[key].text] = key;
      });
      console.info('[voice] 読み上げ音声 ' + Object.keys(payload.clips).length +
                   ' 語 (' + (payload.voice || '?') + ' ×' + self.voiceRate + ')');
    });
  };

  /* 1 つのクリップを読む。同じ読み上げ文は 1 ファイルを共有する。 */
  Sound.prototype.loadClip = function (key) {
    var self = this;
    var clip = this.voiceClips && this.voiceClips[key];
    if (!clip) return Promise.resolve(null);
    var file = clip.file;
    if (this.voiceBuffers[file]) return Promise.resolve(this.voiceBuffers[file]);
    if (this.voicePending[file]) return this.voicePending[file];

    var rel = 'sounds/voice/' + file;
    var src = this.bundled ? (this.bundled[rel] || rel) : rel;
    var direct = src.slice(0, 5) === 'data:' ? dataUriToBuffer(src) : null;
    var p = (direct ? Promise.resolve(direct)
                    : fetch(src, { cache: 'force-cache' })
                        .then(function (r) { return r.ok ? r.arrayBuffer() : Promise.reject(); }))
      .then(function (buf) {
        return new Promise(function (resolve, reject) {
          self.ctx.decodeAudioData(buf, resolve, reject);
        });
      })
      .then(function (audio) {
        self.voiceBuffers[file] = audio;
        self.voiceTrim[file] = trimRange(audio);
        return audio;
      })
      .catch(function () { return null; });
    this.voicePending[file] = p;
    return p;
  };

  /* 前後の無音を落とした範囲を求める.
   *
   * 合成サーバが返す音は前後に無音が付いていて、そのままつなぐと部品ごとに
   * 間が空いて途切れ途切れに聞こえる。鳴らす範囲だけを切り出して詰める。 */
  function trimRange(buf) {
    var d = buf.getChannelData(0), n = d.length, peak = 0, i;
    for (i = 0; i < n; i++) { var a = d[i] < 0 ? -d[i] : d[i]; if (a > peak) peak = a; }
    var th = peak * TRIM_THRESHOLD;
    if (!(th > 0)) return { offset: 0, duration: buf.duration };
    var first = 0, last = n - 1;
    while (first < n && Math.abs(d[first]) < th) first++;
    while (last > first && Math.abs(d[last]) < th) last--;
    var margin = Math.round(TRIM_MARGIN * buf.sampleRate);
    first = Math.max(0, first - margin);
    last = Math.min(n - 1, last + margin);
    return { offset: first / buf.sampleRate, duration: (last - first + 1) / buf.sampleRate };
  }

  /* クリップの列を順につないで再生する (欠けている部品があれば使わない) */
  Sound.prototype.playSequence = function (keys) {
    if (!this.ctx || !this.enabled || !this.speechEnabled || !this.voiceClips) return false;
    var self = this;
    var wanted = keys.filter(Boolean);
    for (var i = 0; i < wanted.length; i++) {
      if (wanted[i] === PAUSE) continue;
      if (!this.voiceClips[wanted[i]]) {
        console.warn('[voice] 部品が足りません: ' + wanted[i]);
        return false;
      }
    }

    this.stopVoice();
    if (!this.voiceOut) {
      // 読み上げは残響を通さずに出す (言葉がにじまないように)
      this.voiceOut = this.ctx.createGain();
      this.voiceOut.gain.value = VOICE_GAIN;
      this.voiceOut.connect(this.ctx.destination);
    }
    var token = (this._voiceToken = (this._voiceToken || 0) + 1);
    Promise.all(wanted.map(function (k) {
      return k === PAUSE ? Promise.resolve(PAUSE) : self.loadClip(k);
    })).then(function (buffers) {
      if (token !== self._voiceToken) return;
      if (buffers.some(function (b) { return !b; })) return;
      var rate = self.voiceRate || 1;
      var at = self.voiceStartTime();
      self._voiceNodes = [];
      // 部品は重ねずに、わずかな間をおいて並べる。重ねて混ぜると
      // 語尾が削れて聞き取りにくくなる。
      buffers.forEach(function (buf, i) {
        if (buf === PAUSE) { at += VOICE_PAUSE; return; }
        var cut = self.voiceTrim[self.voiceClips[wanted[i]].file] ||
                  { offset: 0, duration: buf.duration };
        var src = self.ctx.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = rate;
        src.connect(self.voiceOut);
        src.start(at, cut.offset, cut.duration);
        self._voiceNodes.push(src);
        at += cut.duration / rate + VOICE_GAP;
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
    '5弱': 'shindo_5m', '5強': 'shindo_5p', '6弱': 'shindo_6m', '6強': 'shindo_6p',
    '7': 'shindo_7'
  };
  var DEPTHS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 120, 150, 200, 250,
                300, 350, 400, 450, 500, 550, 600, 650, 700];

  /* 津波の段 -> クリップ名 / 予想される高さ -> クリップ名 */
  var TSU_KIND_CLIP = { 3: 'tsu_major', 2: 'tsu_warning', 1: 'tsu_advisory' };
  var HEIGHT_CLIP = {
    '10m超': 'height_10p', '10m': 'height_10', '5m': 'height_5', '3m': 'height_3',
    '1m': 'height_1', '0.2m': 'height_02', '0.2m未満': 'height_slight'
  };
  var TSU_MAX_ZONES = 8;        // 読み上げる予報区の数の上限

  /* 用意してあるのは M3.0〜9.5。外れた値は端に寄せる。 */
  function magClip(m) {
    return Math.min(95, Math.max(30, Math.round(Number(m) * 10)));
  }

  function nearestDepth(km) {
    var best = DEPTHS[0];
    for (var i = 1; i < DEPTHS.length; i++) {
      if (Math.abs(DEPTHS[i] - km) < Math.abs(best - km)) best = DEPTHS[i];
    }
    return best;
  }

  /* 地名 (震央地名・震度観測地域名) は読み上げ文そのもので引く */
  Sound.prototype.regionClip = function (name) {
    return this.voiceByText ? this.voiceByText[name] : null;
  };

  /* 午前/午後と 12 時制の時刻をクリップ名に直す */
  function clockClips(date) {
    var h = date.getHours();
    // 0 時は「午前0時」、12 時は「午後0時」と読む
    return [h < 12 ? 'ampm_am' : 'ampm_pm', 'hour_' + (h % 12), 'min_' + date.getMinutes()];
  }

  /* ---------------- 場面ごとの読み上げ ---------------- */

  /* 揺れの検知
   *   千葉県南部で揺れを検出。
   *
   * 検知の音が鳴り終わってから読む。地域名は細分区域の名前をそのまま使う。 */
  Sound.prototype.announceDetect = function (areaName) {
    this.unlock();
    var clip = this.regionClip(areaName);
    if (clip && this.playSequence([clip, 'detect_tail'])) return;
    this.speak(areaName + 'で揺れを検出。');
  };

  /* 地震速報 (仮)
   *   地震速報。最大震度6強を。宮城県北部。で観測しました。 */
  Sound.prototype.announceFlash = function (info) {
    this.unlock();
    var seq = ['flash_lead', SHINDO_CLIP[info.shindo], 'flash_wo',
               this.regionClip(info.area), PAUSE, 'flash_tail'];
    if (this.playSequence(seq)) return;
    this.speak('地震速報。最大震度' + info.shindo + 'を、' + info.area + 'で観測しました。');
  };

  /* 地震情報 (確定)
   *   地震情報。午後3時47分頃、最大震度6強を観測する地震がありました。
   *   この地震による津波の心配はありません。／現在、津波予報等を発表中です。
   *   震源地は、宮城県沖。深さ60キロメートル。
   *   地震の規模を示すマグニチュードは、7.3と、推定されています。 */
  Sound.prototype.announceQuake = function (info) {
    this.unlock();
    var when = clockClips(info.time || new Date());
    var seq = ['info_lead', when[0], when[1], when[2], 'info_koro',
               SHINDO_CLIP[info.shindo], 'info_observed',
               info.tsunami ? 'info_tsunami_now' : 'info_no_tsunami',
               'info_hypo_lead', this.regionClip(info.region), PAUSE,
               'info_depth_lead', 'depth_' + nearestDepth(Number(info.depth)), 'info_km',
               'mag_' + magClip(info.magnitude), 'info_mag_tail'];
    if (this.playSequence(seq)) return;

    var d = info.time || new Date();
    this.speak('地震情報。' + (d.getHours() < 12 ? '午前' : '午後') +
               (d.getHours() % 12 || 12) + '時' + d.getMinutes() + '分頃、最大震度' +
               info.shindo + 'を観測する地震がありました。' +
               (info.tsunami ? '現在、津波予報等を発表中です。'
                             : 'この地震による津波の心配はありません。') +
               '震源地は、' + info.region + '。深さ' + Math.round(info.depth) +
               'キロメートル。地震の規模を示すマグニチュードは、' +
               Number(info.magnitude).toFixed(1) + 'と、推定されています。');
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

  /* 緊急地震速報
   *   宮城県沖で地震。推定最大震度6強
   *
   * 第 1 報の音が鳴り終わってから、一度だけ読む。 */
  Sound.prototype.announceEEW = function (report) {
    this.unlock();
    var seq = [this.regionClip(report.region), 'eew_tail', SHINDO_CLIP[report.maxShindo]];
    if (this.playSequence(seq)) return;
    this.speak(report.region + 'で地震。推定最大震度' + report.maxShindo);
  };

  /* 津波警報・大津波警報・津波注意報の読み上げ。
   *
   *   #1 大津波警報が次の地域に発表されています。直ちに避難してください。
   *      宮城県。岩手県。以上の地域で、予想される津波の高さは、10メートル以上です。
   *   #2 また、津波注意報が、次の地域に発表されています。
   *      千葉県九十九里・外房。以上の地域で、予想される津波の高さは、1メートルです。
   *   #3 震源に関する情報。震源地は、宮城県沖。深さ20キロメートル。
   *      地震の規模を示すマグニチュードは、9.0と、推定されています。
   *      現在、大津波警報等を発表中です。海岸からは直ちに離れてください。
   *
   * 津波注意報だけのときは #1 を軽くしたものだけ、津波予報は効果音だけにする。 */
  Sound.prototype.announceTsunami = function (forecast, source) {
    this.unlock();
    if (!forecast || forecast.maxLevel <= 0) return;    // 津波予報は音だけ

    // 発表の段ごとにまとめ、強いものから読む
    var byLevel = {};
    forecast.zones.forEach(function (z) {
      if (z.level >= 1) (byLevel[z.level] || (byLevel[z.level] = [])).push(z);
    });
    var levels = Object.keys(byLevel).map(Number).sort(function (a, b) { return b - a; });
    if (!levels.length) return;

    var self = this, seq = [];
    levels.forEach(function (lv, i) {
      var list = byLevel[lv].slice().sort(function (a, b) { return b.height - a.height; });
      if (i === 0) {
        seq.push(TSU_KIND_CLIP[lv], 'tsu_issued');
        if (lv >= 2) seq.push('tsu_evacuate');       // 注意報では避難を呼びかけない
      } else {
        seq.push('tsu_mata', TSU_KIND_CLIP[lv], 'tsu_issued2');
      }
      list.slice(0, TSU_MAX_ZONES).forEach(function (z) {
        seq.push(self.regionClip(z.name), PAUSE);
      });
      seq.push('tsu_ijou', HEIGHT_CLIP[list[0].heightClass], 'tsu_desu');
    });

    if (forecast.maxLevel >= 2 && source) {
      // #3 震源に関する情報
      seq.push('hypo_lead', this.regionClip(source.region), PAUSE,
               'info_depth_lead', 'depth_' + nearestDepth(Number(source.depth)), 'info_km',
               'mag_' + magClip(source.magnitude), 'info_mag_tail',
               'tsu_now_lead', TSU_KIND_CLIP[forecast.maxLevel], 'tsu_now_tail');
    } else if (forecast.maxLevel === 1) {
      seq.push('tsu_leave_sea');
    }
    if (this.playSequence(seq)) return;

    var names = forecast.zones.slice(0, 3).map(function (z) { return z.name; }).join('、');
    var text = {
      3: '大津波警報。ただちに高台や避難ビルへ避難してください。',
      2: '津波警報。ただちに海岸から離れ、高台へ避難してください。',
      1: '津波注意報。海の中や海岸から離れてください。'
    }[forecast.maxLevel] || '津波予報。';
    this.speak(text + '対象は、' + names + 'など。');
  };

  global.Sound = Sound;
})(window);
