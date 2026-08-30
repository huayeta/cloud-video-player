/*!
 * CloudVodPlayer SDK
 * 云点播播放器嵌入组件 —— Shadow DOM 样式隔离，支持任意格式远程视频播放
 * 用法：
 *   <div id="player" style="width:100%;aspect-ratio:16/9;"></div>
 *   <script src="http://你的服务器:8787/embed.js"></script>
 *   <script>
 *     var p = new CloudVodPlayer('#player', { url: 'https://example.com/1.avi' });
 *     p.on('timeupdate', function(t){ console.log(t); });
 *   </script>
 */
(function (global) {
  'use strict';

  /* ==================== 样式（Shadow DOM 内联，与宿主页面完全隔离） ==================== */
  var PLAYER_CSS = `
:host{
  display:block;
  --bg:#0a0d12; --panel:#11161f; --panel-2:#161d29;
  --line:#232c3b; --line-soft:#1b2330;
  --text:#e9ecf1; --text-2:#98a2b3; --text-3:#6b7686;
  --accent:#f2b24c; --accent-soft:rgba(242,178,76,.14); --accent-2:#ffd27d;
  --danger:#ff6b6b; --ok:#4cc38a;
  --radius:16px;
  font-family:"Noto Sans SC","PingFang SC","Microsoft YaHei",system-ui,-apple-system,sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0}
.player-stage{
  position:relative;width:100%;height:100%;
  background:#000;border-radius:var(--radius);overflow:hidden;
  box-shadow:0 24px 60px rgba(0,0,0,.5);
  border:1px solid var(--line-soft);
  cursor:pointer;user-select:none;-webkit-user-select:none;touch-action:manipulation;
  outline:none;
}
.player-stage video{width:100%;height:100%;display:block;object-fit:contain;background:#000}
.stage-overlay{
  position:absolute;inset:0;display:grid;place-items:center;
  pointer-events:none;z-index:5;
}
.stage-overlay[hidden]{display:none}
.spinner{
  width:58px;height:58px;border-radius:50%;
  border:3px solid rgba(255,255,255,.15);border-top-color:var(--accent);
  animation:cvp-spin .8s linear infinite;
}
@keyframes cvp-spin{to{transform:rotate(360deg)}}
.error-box{
  max-width:86%;text-align:center;padding:20px 26px;border-radius:12px;
  background:rgba(12,10,10,.82);border:1px solid rgba(255,107,107,.4);
  color:#ffd9d9;font-size:13.5px;line-height:1.7;
}
.error-box b{display:block;color:#ff8f8f;font-size:15px;margin-bottom:6px}
.idle-box{text-align:center;color:var(--text-3)}
.idle-box .idle-mark{color:var(--accent);opacity:.85;margin-bottom:12px}
.idle-box p{font-size:13.5px;letter-spacing:.4px}
.big-play{
  position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
  width:84px;height:84px;border-radius:50%;
  display:grid;place-items:center;
  background:rgba(10,10,12,.5);backdrop-filter:blur(4px);
  border:1px solid rgba(255,255,255,.25);
  color:#fff;cursor:pointer;
  transition:transform .16s,background .16s,opacity .2s;z-index:6;
}
.big-play:hover{transform:translate(-50%,-50%) scale(1.06);background:rgba(242,178,76,.9);color:#1a1205}
.big-play[hidden]{display:none}
.stage-top{
  position:absolute;left:0;right:0;top:0;
  display:flex;align-items:center;gap:10px;
  padding:12px 16px;
  background:linear-gradient(180deg,rgba(0,0,0,.55),transparent);
  opacity:0;transition:opacity .25s;pointer-events:none;z-index:4;
}
.player-stage:hover .stage-top,.player-stage.controls-on .stage-top{opacity:1}
.fmt-tag{
  font-size:11px;font-weight:700;letter-spacing:1px;
  padding:3px 9px;border-radius:999px;
  background:var(--accent-soft);color:var(--accent-2);
  border:1px solid rgba(242,178,76,.35);
  font-family:"JetBrains Mono",monospace;
}
.stage-title{
  font-size:12.5px;color:rgba(255,255,255,.85);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  font-family:"JetBrains Mono",monospace;
}
.controls{
  position:absolute;left:0;right:0;bottom:0;z-index:7;
  padding:26px 16px 12px;
  background:linear-gradient(0deg,rgba(0,0,0,.78),rgba(0,0,0,.25) 70%,transparent);
  opacity:0;transform:translateY(6px);
  transition:opacity .25s,transform .25s;pointer-events:none;
}
.player-stage:hover .controls,
.player-stage.controls-on .controls,
.player-stage:not(.playing) .controls{opacity:1;transform:none;pointer-events:auto}
.player-stage.controls-lock .controls{opacity:1!important;transform:none!important;pointer-events:auto!important}
.progress-row{padding:2px 0 8px;cursor:pointer}
.progress{position:relative;height:18px;display:flex;align-items:center}
.progress-track{
  position:relative;width:100%;height:4px;border-radius:999px;
  background:rgba(255,255,255,.22);transition:height .12s;
}
.progress:hover .progress-track{height:6px}
.progress-buffer{position:absolute;left:0;top:0;bottom:0;border-radius:999px;background:rgba(255,255,255,.32)}
.progress-transcoded{position:absolute;left:0;top:0;bottom:0;border-radius:999px;background:rgba(242,178,76,.22)}
.progress-played{position:absolute;left:0;top:0;bottom:0;border-radius:999px;background:linear-gradient(90deg,var(--accent-2),var(--accent))}
.progress-thumb{
  position:absolute;top:50%;width:13px;height:13px;border-radius:50%;
  background:var(--accent-2);transform:translate(-50%,-50%) scale(0);
  box-shadow:0 0 0 3px rgba(242,178,76,.25);transition:transform .14s;
}
.progress:hover .progress-thumb,.progress.scrubbing .progress-thumb{transform:translate(-50%,-50%) scale(1)}
.transcode-hint{
  position:absolute;top:50%;transform:translateY(-50%);
  right:10px;font-size:11px;font-weight:600;letter-spacing:.5px;
  color:var(--accent-2);background:rgba(10,13,18,.85);
  border:1px solid rgba(242,178,76,.4);border-radius:6px;
  padding:2px 8px;pointer-events:none;white-space:nowrap;
  opacity:0;transition:opacity .2s;z-index:2;
}
.transcode-hint.on{opacity:1}
.scrub-bubble{
  position:absolute;bottom:26px;transform:translateX(-50%);
  background:#11161f;color:var(--text);
  border:1px solid var(--line);border-radius:8px;
  padding:4px 10px;font-size:12px;
  font-family:"JetBrains Mono",monospace;
  opacity:0;transition:opacity .15s;pointer-events:none;white-space:nowrap;
  box-shadow:0 6px 18px rgba(0,0,0,.4);
}
.progress.scrubbing .scrub-bubble{opacity:1}
.ctrl-row{display:flex;align-items:center;gap:6px;color:#fff}
.icon-btn{
  width:44px;height:44px;border:none;background:transparent;color:#fff;cursor:pointer;
  display:grid;place-items:center;border-radius:10px;transition:background .15s,color .15s;
}
.ctrl-icon.hide{display:none!important}
.icon-btn:hover{background:rgba(255,255,255,.14)}
.time{
  font-size:12.5px;color:rgba(255,255,255,.85);
  font-family:"JetBrains Mono",monospace;padding:0 10px;white-space:nowrap;letter-spacing:.3px;
}
.spacer{flex:1}
.vol-group{display:flex;align-items:center}
.vol-range{
  width:0;opacity:0;overflow:hidden;
  -webkit-appearance:none;appearance:none;height:4px;border-radius:999px;
  background:rgba(255,255,255,.25);outline:none;transition:width .2s,opacity .2s,margin .2s;
}
.vol-group:hover .vol-range{width:92px;opacity:1;margin-left:4px}
.vol-range::-webkit-slider-thumb{
  -webkit-appearance:none;appearance:none;width:12px;height:12px;border-radius:50%;
  background:var(--accent-2);cursor:pointer;
}
.vol-range::-moz-range-thumb{width:12px;height:12px;border:none;border-radius:50%;background:var(--accent-2);cursor:pointer}
.rate-sel{
  height:34px;border-radius:8px;padding:0 8px;
  background:rgba(255,255,255,.1);color:#fff;
  border:1px solid rgba(255,255,255,.18);
  font-size:12.5px;outline:none;cursor:pointer;
  font-family:"JetBrains Mono",monospace;
}
.rate-sel option{background:#161d29;color:#e9ecf1}
.player-stage:fullscreen{border-radius:0;border:none}
.player-stage:fullscreen video{object-fit:contain}
@media (max-width:480px){
  .vol-group .vol-range{width:56px;opacity:1;margin-left:4px}
}
`;

  /* ==================== HTML 模板 ==================== */
  var PLAYER_HTML = `
<div class="player-stage" tabindex="0">
  <video playsinline preload="auto"></video>
  <div class="stage-top">
    <span class="fmt-tag">--</span>
    <span class="stage-title">等待加载视频</span>
  </div>
  <div class="stage-overlay idle-box-el">
    <div class="idle-box">
      <div class="idle-mark"><svg viewBox="0 0 24 24" width="56" height="56" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></div>
      <p class="idle-text">点击播放</p>
    </div>
  </div>
  <div class="stage-overlay loading-box-el" hidden><div class="spinner"></div></div>
  <div class="stage-overlay error-box-el" hidden>
    <div class="error-box"><b class="error-title">无法播放</b><span class="error-text"></span></div>
  </div>
  <button class="big-play" hidden aria-label="播放"><svg viewBox="0 0 24 24" width="36" height="36" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>
  <div class="controls">
    <div class="progress-row">
      <div class="progress">
        <div class="progress-track">
          <div class="progress-buffer"></div>
          <div class="progress-transcoded" hidden></div>
          <div class="progress-played"></div>
          <div class="progress-thumb"></div>
        </div>
        <div class="transcode-hint" hidden>转码中…</div>
        <div class="scrub-bubble">00:00</div>
      </div>
    </div>
    <div class="ctrl-row">
      <button class="icon-btn play-pause-btn" aria-label="播放/暂停">
        <svg class="ctrl-icon icon-play" viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        <svg class="ctrl-icon icon-pause hide" viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>
      </button>
      <span class="time">00:00 / 00:00</span>
      <div class="spacer"></div>
      <div class="vol-group">
        <button class="icon-btn mute-btn" aria-label="静音">
          <svg class="ctrl-icon icon-vol" viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3z"/><path d="M15.5 8.5a5 5 0 0 1 0 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M18.2 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          <svg class="ctrl-icon icon-muted hide" viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3z"/><path d="M16 9l6 6M22 9l-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>
        </button>
        <input class="vol-range" type="range" min="0" max="100" value="100" aria-label="音量">
      </div>
      <select class="rate-sel" aria-label="倍速">
        <option value="0.5">0.5x</option>
        <option value="0.75">0.75x</option>
        <option value="1" selected>1.0x</option>
        <option value="1.25">1.25x</option>
        <option value="1.5">1.5x</option>
        <option value="2">2.0x</option>
      </select>
      <button class="icon-btn pip-btn" aria-label="画中画" hidden>
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="11" width="8" height="6" fill="currentColor" stroke="none"/></svg>
      </button>
      <button class="icon-btn fs-btn" aria-label="全屏">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/></svg>
      </button>
    </div>
  </div>
</div>
`;

  /* ==================== 服务器地址推断 ==================== */
  var SCRIPT_SRC = (document.currentScript && document.currentScript.src) || '';
  var SERVER_ORIGIN = '';
  try { if (SCRIPT_SRC) SERVER_ORIGIN = new URL(SCRIPT_SRC).origin; } catch (e) {}

  function apiUrl(path) {
    return SERVER_ORIGIN ? SERVER_ORIGIN + path : path;
  }

  /* ==================== 工具函数 ==================== */
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    s = Math.floor(s);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return (h > 0 ? h + ':' + pad(m) : m) + ':' + pad(sec);
  }
  function shortName(url) {
    try {
      var u = new URL(url);
      var path = u.pathname.split('/').filter(Boolean);
      return path.length ? path[path.length - 1].slice(0, 42) : u.host;
    } catch (e) { return url.slice(0, 42); }
  }

  /* ==================== hls.js 动态加载 ==================== */
  var hlsLoaded = false, hlsLoading = false, hlsCbs = [];
  function loadHls(cb) {
    if (typeof Hls !== 'undefined') { cb(); return; }
    if (hlsLoaded) { cb(); return; }
    hlsCbs.push(cb);
    if (hlsLoading) return;
    hlsLoading = true;
    var s = document.createElement('script');
    // 从本地服务器加载 hls.js，不依赖 CDN，避免跨域/网络问题导致加载失败、
    // 回调永远不执行（表现为转码在后台跑、ts 已产出但前端不播、loading 卡死）
    s.src = (SERVER_ORIGIN || '') + '/hls.min.js';
    s.onload = function () {
      hlsLoaded = true; hlsLoading = false;
      hlsCbs.forEach(function (fn) { try { fn(); } catch (e) {} });
      hlsCbs = [];
    };
    s.onerror = function () {
      hlsLoading = false;
      // 加载失败也执行回调：回调内会检测到 Hls 未定义，走 Safari 原生 HLS 或显示错误，
      // 避免回调队列卡死、loading 永远不消失
      var cbs = hlsCbs; hlsCbs = [];
      cbs.forEach(function (fn) { try { fn(); } catch (e) {} });
    };
    document.head.appendChild(s);
  }

  /* ==================== 全局转码并发控制 ==================== */
  var activeTranscodes = 0;
  var MAX_CONCURRENT = 3;
  var transcodeQueue = [];
  function acquireTranscode() {
    if (activeTranscodes < MAX_CONCURRENT) { activeTranscodes++; return true; }
    return false;
  }
  function releaseTranscode() {
    activeTranscodes = Math.max(0, activeTranscodes - 1);
    if (transcodeQueue.length) {
      var next = transcodeQueue.shift();
      activeTranscodes++;
      next();
    }
  }

  /* ==================== CloudVodPlayer 类 ==================== */
  function CloudVodPlayer(selector, options) {
    if (!(this instanceof CloudVodPlayer)) return new CloudVodPlayer(selector, options);
    options = options || {};
    this.options = options;
    this.server = options.server || SERVER_ORIGIN || '';
    this.theme = options.theme || {};
    this.autoplay = !!options.autoplay;
    this.muted = !!options.muted;
    this.lazy = options.lazy !== false; // 默认懒加载

    // 事件系统
    this._listeners = {};

    // 播放器状态
    this.currentUrl = '';
    this.playing = false;
    this.scrubbing = false;
    this.hideTimer = null;
    this.knownDuration = null;
    this.transcodeSid = null;
    this.transcodeDone = false;
    this.transcodedSec = 0;
    this.transcodeBase = 0;
    this.transcodeMode = false;
    this.hls = null;
    this.pollToken = 0;
    this.pendingSeekT = 0;
    this.holdTimer = null;
    this.waitTimer = null;
    this.destroyed = false;
    this._initialized = false;

    // 找到容器
    var el = typeof selector === 'string' ? document.querySelector(selector) : selector;
    if (!el) { console.error('[CloudVodPlayer] 容器未找到:', selector); return; }
    this.container = el;

    // 懒加载：滚到可视区附近再初始化
    if (this.lazy && 'IntersectionObserver' in window) {
      var self = this;
      this._io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            self._io.disconnect();
            self._init();
          }
        });
      }, { rootMargin: '200px' });
      this._io.observe(el);
    } else {
      this._init();
    }
  }

  /* ---------- 初始化与渲染 ---------- */
  CloudVodPlayer.prototype._init = function () {
    if (this._initialized || this.destroyed) return;
    this._initialized = true;

    var container = this.container;
    container.innerHTML = '';

    // Shadow DOM
    var shadow = container.attachShadow({ mode: 'open' });
    this.shadow = shadow;

    // 样式
    var style = document.createElement('style');
    style.textContent = PLAYER_CSS;
    shadow.appendChild(style);

    // HTML
    var wrap = document.createElement('div');
    wrap.innerHTML = PLAYER_HTML;
    shadow.appendChild(wrap.firstElementChild);

    // 缓存 DOM 引用
    var root = shadow.querySelector('.player-stage');
    this.stage = root;
    this.video = root.querySelector('video');
    this.fmtTag = root.querySelector('.fmt-tag');
    this.stageTitle = root.querySelector('.stage-title');
    this.idleBox = root.querySelector('.idle-box-el');
    this.loadingBox = root.querySelector('.loading-box-el');
    this.errorBox = root.querySelector('.error-box-el');
    this.errorTitle = root.querySelector('.error-title');
    this.errorText = root.querySelector('.error-text');
    this.bigPlay = root.querySelector('.big-play');
    this.playPauseBtn = root.querySelector('.play-pause-btn');
    this.iconPlay = root.querySelector('.icon-play');
    this.iconPause = root.querySelector('.icon-pause');
    this.timeText = root.querySelector('.time');
    this.progress = root.querySelector('.progress');
    this.progressRow = root.querySelector('.progress-row');
    this.progressBuffer = root.querySelector('.progress-buffer');
    this.progressTranscoded = root.querySelector('.progress-transcoded');
    this.transcodeHint = root.querySelector('.transcode-hint');
    this.progressPlayed = root.querySelector('.progress-played');
    this.progressThumb = root.querySelector('.progress-thumb');
    this.scrubBubble = root.querySelector('.scrub-bubble');
    this.muteBtn = root.querySelector('.mute-btn');
    this.iconVol = root.querySelector('.icon-vol');
    this.iconMuted = root.querySelector('.icon-muted');
    this.volRange = root.querySelector('.vol-range');
    this.rateSel = root.querySelector('.rate-sel');
    this.pipBtn = root.querySelector('.pip-btn');
    this.fsBtn = root.querySelector('.fs-btn');

    // 主题覆盖
    if (this.theme.primary) {
      this.stage.style.setProperty('--accent', this.theme.primary);
    }
    if (this.theme.radius) {
      this.stage.style.setProperty('--radius', this.theme.radius);
    }

    // 初始状态
    this.seeking = false;   // seek 跳转中标志位：seek 期间忽略暂停/播放操作，避免与自动 play() 竞态
    if (this.muted) { this.video.muted = true; this._updateMuteUI(); }
    if (document.pictureInPictureEnabled) this.pipBtn.hidden = false;

    this._bindEvents();

    // 预加载 hls.js：避免用户首次点击播放时因动态加载 hls.js 导致用户交互上下文过期，
    // 进而 video.play() 被自动播放策略拒绝（表现为 ts 已下载但视频不播）
    loadHls(function () {});

    // 自动加载
    if (this.options.url) {
      this.load(this.options.url);
    }
  };

  /* ---------- API 路径（支持自定义 server） ---------- */
  CloudVodPlayer.prototype._api = function (path) {
    return this.server ? this.server + path : path;
  };

  /* ---------- 事件系统 ---------- */
  CloudVodPlayer.prototype.on = function (event, cb) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(cb);
    return this;
  };
  CloudVodPlayer.prototype.off = function (event, cb) {
    if (!this._listeners[event]) return this;
    this._listeners[event] = this._listeners[event].filter(function (fn) { return fn !== cb; });
    return this;
  };
  CloudVodPlayer.prototype._emit = function (event, data) {
    var list = this._listeners[event];
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      try { list[i](data, this); } catch (e) { console.error('[CloudVodPlayer] 事件回调错误:', e); }
    }
  };

  /* ---------- 公开 API ---------- */
  CloudVodPlayer.prototype.load = function (url) {
    if (!this._initialized) { this.options.url = url; return this; }
    if (!url || !url.trim()) return this;
    this._loadVideo(url.trim());
    return this;
  };
  CloudVodPlayer.prototype.play = function () {
    if (this.video && this.video.src) {
      var self = this;
      this.video.play().catch(function () {
        self._showError('播放被阻止', '请点击播放器上的播放按钮手动开始。');
      });
    }
    return this;
  };
  CloudVodPlayer.prototype.pause = function () {
    if (this.video) this.video.pause();
    return this;
  };
  CloudVodPlayer.prototype.seek = function (time) {
    if (this.video && isFinite(time)) this._doSeek(time);
    return this;
  };
  CloudVodPlayer.prototype.getCurrentTime = function () {
    return this._videoCurrent();
  };
  CloudVodPlayer.prototype.getDuration = function () {
    return this._effectiveDuration();
  };
  CloudVodPlayer.prototype.destroy = function () {
    if (this.destroyed) return;
    this.destroyed = true;
    this._stopHoldAlive();
    this._stopExisting();
    if (this.transcodeSid) {
      var sid = this.transcodeSid;
      fetch(this._api('/api/stop?sid=' + encodeURIComponent(sid))).catch(function () {});
      if (this.transcodeMode) releaseTranscode();
    }
    if (this._io) { try { this._io.disconnect(); } catch (e) {} }
    if (this.hideTimer) clearTimeout(this.hideTimer);
    if (this.waitTimer) clearTimeout(this.waitTimer);
    this._resetContainerRatio();   // 销毁时重置容器比例，恢复用户默认设置
    if (this.container) this.container.innerHTML = '';
    this._emit('destroy');
    this._listeners = {};
  };

  /* ---------- 核心：探测并播放 ---------- */
  CloudVodPlayer.prototype._loadVideo = function (url) {
    var self = this;
    // 终止上一个转码会话
    if (this.transcodeSid) {
      var oldSid = this.transcodeSid;
      this.transcodeSid = null;
      fetch(this._api('/api/stop?sid=' + encodeURIComponent(oldSid))).catch(function () {});
      if (this.transcodeMode) releaseTranscode();
    }
    this._stopExisting();
    this.pollToken++;
    this.currentUrl = url;
    this.errorBox.hidden = true;
    this.idleBox.hidden = true;
    this._showLoading();
    this._setPlaying(false);
    this._resetProgress();
    this._resetContainerRatio();   // 切换视频时重置容器比例，新视频加载后再自适应
    this.stageTitle.textContent = shortName(url);
    this.knownDuration = null;
    this.transcodeSid = null;
    this.transcodeDone = false;
    this.transcodedSec = 0;
    this.transcodeBase = 0;
    this.transcodeMode = false;

    fetch(this._api('/api/probe?url=' + encodeURIComponent(url)))
      .then(function (r) { return r.json(); })
      .then(function (info) {
        if (self.destroyed || self.currentUrl !== url) return;
        var mode = info.mode || 'native';
        self._setFmtTag(mode);
        if (mode === 'native') {
          self.video.src = self._api('/api/proxy?url=' + encodeURIComponent(url));
          self.video.play().catch(function () { self.seeking = false; self._hideLoading(); self._setPlaying(false); });
        } else if (mode === 'hls') {
          self._playHLS(self._api('/api/hlsproxy?url=' + encodeURIComponent(url)), false);
        } else if (mode === 'transcode') {
          self.transcodeMode = true;
          // 并发控制
          if (!acquireTranscode()) {
            self._hideLoading();
            self._showError('转码繁忙', '当前转码任务过多，请稍后再试。');
            return;
          }
          fetch(self._api('/api/transcode?url=' + encodeURIComponent(url)))
            .then(function (r) { return r.json(); })
            .then(function (t) {
              if (self.destroyed || self.currentUrl !== url) return;
              if (t.playlist) {
                self.transcodeSid = t.sid || null;
                self.transcodeBase = t.startSec || 0;
                self._playHLS(self._api(t.playlist), true);
                self._pollTranscodeStatus();
              } else {
                releaseTranscode();
                self._showError('转码失败', t.error || '无法启动转码服务');
              }
            })
            .catch(function () {
              releaseTranscode();
              self._showError('转码失败', '无法连接转码服务。');
            });
        }
      })
      .catch(function () {
        if (self.destroyed) return;
        self._showError('无法连接服务器', '请确认云点播服务已启动。');
      });
  };

  /* ---------- HLS 播放 ---------- */
  CloudVodPlayer.prototype._playHLS = function (src, isTranscode) {
    var self = this;
    loadHls(function () {
      if (self.destroyed) return;
      if (typeof Hls !== 'undefined' && Hls.isSupported()) {
        self.hls = new Hls({
          lowLatencyMode: false, startLevel: -1, capLevelToPlayerSize: true,
          manifestLoadingTimeOut: isTranscode ? 60000 : 15000,
          manifestLoadingMaxRetry: isTranscode ? 10 : 2,
          manifestLoadingRetryDelay: 2000, manifestLoadingMaxRetryTimeout: 90000,
          levelLoadingTimeOut: 20000, fragLoadingTimeOut: 30000,
          maxBufferLength: 30, maxMaxBufferLength: 60,
          liveSyncDurationCount: 5, backBufferLength: 60
        });
        self.hls.loadSource(src);
        self.hls.attachMedia(self.video);
        self.hls.on(Hls.Events.MANIFEST_PARSED, function () {
          // 不在这里 hideLoading：等 playing 事件（真正开始播放）再隐藏，
          // 避免首个分片加载期间黑屏让用户以为卡住了
          self.video.play().catch(function () {
            // 自动播放被浏览器策略拒绝（常见于动态加载 hls.js 后用户交互上下文过期），
            // 显示大播放按钮，用户点击即可正常播放
            self.seeking = false;
            self._hideLoading();
            self._setPlaying(false);
          });
        });
        self.hls.on(Hls.Events.ERROR, function (e, data) {
          if (!data.fatal) return;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) self.hls.startLoad();
          else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) self.hls.recoverMediaError();
          else self._showError('HLS 播放失败', '无法解析该 m3u8 流。');
        });
      } else if (self.video.canPlayType('application/vnd.apple.mpegurl')) {
        self.video.src = src;
        self.video.play().catch(function () { self.seeking = false; self._hideLoading(); self._setPlaying(false); });
      } else {
        self.seeking = false;
        self._hideLoading();
        if (typeof Hls === 'undefined') {
          self._showError('播放器加载失败', 'hls.js 未能加载，请刷新页面重试。');
        } else {
          self._showError('浏览器不支持 HLS', '当前浏览器无法播放 m3u8 流。');
        }
      }
    });
  };

  /* ---------- 转码状态轮询 ---------- */
  CloudVodPlayer.prototype._pollTranscodeStatus = function () {
    if (!this.transcodeSid || this.transcodeDone || this.destroyed) return;
    var self = this, myToken = this.pollToken;
    fetch(this._api('/api/status?sid=' + encodeURIComponent(this.transcodeSid)))
      .then(function (r) {
        if (r.status === 429) throw { throttled: true };
        return r.json();
      })
      .then(function (st) {
        if (self.destroyed || myToken !== self.pollToken) return;
        if (st.startSec !== undefined) self.transcodeBase = st.startSec || 0;
        if (st.duration && !self.knownDuration) {
          self.knownDuration = st.duration;
          self._refreshProgressUI();
          self._emit('durationchange', self.knownDuration);
        }
        if (st.transcoded && self.knownDuration) {
          self.transcodedSec = self.transcodeBase + st.transcoded;
          self.progressTranscoded.hidden = false;
          self.progressTranscoded.style.width = clamp(self.transcodedSec / self.knownDuration, 0, 1) * 100 + '%';
          self._updateTranscodeHint();
        }
        if (st.error && !self.video.src) { self._showError('转码失败', st.error); return; }
        var absTranscoded = (self.transcodeBase || 0) + (st.transcoded || 0);
        if (self.currentUrl && (!self.knownDuration || absTranscoded < (self.knownDuration || 0) - 1)) {
          setTimeout(function () { if (myToken === self.pollToken && !self.destroyed) self._pollTranscodeStatus(); }, self.knownDuration ? 5000 : 3000);
        } else {
          self.progressTranscoded.style.width = '100%';
          self.transcodedSec = self.knownDuration;
          self.transcodeDone = true;
          self._updateTranscodeHint();
        }
      })
      .catch(function (err) {
        if (myToken === self.pollToken && self.currentUrl && !self.destroyed)
          setTimeout(function () { if (myToken === self.pollToken && !self.destroyed) self._pollTranscodeStatus(); }, err && err.throttled ? 5000 : 2000);
      });
  };

  /* ---------- 拖拽跳转 ---------- */
  CloudVodPlayer.prototype._seekFromEvent = function (e) {
    var rect = this.progress.getBoundingClientRect();
    var ratio = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    var dur = this._effectiveDuration();
    this.progressPlayed.style.width = (ratio * 100) + '%';
    this.progressThumb.style.left = (ratio * 100) + '%';
    this.scrubBubble.style.left = (ratio * 100) + '%';
    var t = dur > 0 ? ratio * dur : 0;
    this.scrubBubble.textContent = fmtTime(t);
    this.pendingSeekT = t;
    var durTxt = dur > 0 ? fmtTime(dur) : '00:00';
    this.timeText.textContent = fmtTime(t) + ' / ' + durTxt;
  };

  CloudVodPlayer.prototype._doSeek = function (t) {
    if (this.transcodeMode && this.knownDuration && t < this.knownDuration - 0.5) {
      if (t < (this.transcodeBase || 0) - 1 || t > this.transcodedSec + 1) {
        this._seekTranscode(t);
        return;
      }
      try { this.video.currentTime = clamp(t - (this.transcodeBase || 0), 0, (this.video.duration || 0)); } catch (e) {}
      return;
    }
    try { this.video.currentTime = clamp(t - (this.transcodeBase || 0), 0, (this.video.duration || 0)); } catch (e) {}
  };

  CloudVodPlayer.prototype._seekTranscode = function (t) {
    var self = this;
    this.seeking = true;   // 标记跳转中：期间忽略暂停/播放操作，避免与新会话的自动 play() 竞态
    this._showLoading();
    var sid = this.transcodeSid;
    this._stopExisting();
    var ep = sid
      ? this._api('/api/seek?sid=' + encodeURIComponent(sid) + '&to=' + Math.max(0, Math.floor(t)))
      : this._api('/api/transcode?url=' + encodeURIComponent(this.currentUrl) + '&start=' + Math.max(0, Math.floor(t)));
    fetch(ep)
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (self.destroyed) return;
        if (res.ok || res.playlist) {
          self.pollToken++;
          self.transcodeSid = res.sid || sid || null;
          self.transcodeDone = false;
          self.transcodeBase = res.startSec || 0;
          self.transcodedSec = self.transcodeBase;
          // seek 复用同一会话目录，m3u8 URL 与旧会话相同：加时间戳缓存破坏参数，
          // 防止 hls.js 使用缓存的旧 m3u8（指向旧分片列表），导致跳转后仍从头播放
          self._playHLS(self._api(res.playlist) + '?t=' + Date.now(), true);
          self._pollTranscodeStatus();
          // 不在这里 hideLoading：_playHLS 是异步的，等 playing 事件（真正开始播放）再隐藏，
          // 避免黑屏让用户以为卡住了
        } else {
          self.seeking = false;
          self._hideLoading();
          self._showError('跳转失败', res.error || '无法从该位置启动转码');
        }
      })
      .catch(function () {
        self.seeking = false;
        self._hideLoading();
        self._showError('跳转失败', '无法连接转码服务。');
      });
  };

  /* ---------- UI 辅助 ---------- */
  CloudVodPlayer.prototype._effectiveDuration = function () {
    if (this.knownDuration && this.knownDuration > 0) return this.knownDuration;
    var d = this.video.duration;
    return (isFinite(d) && d > 0) ? d : 0;
  };
  CloudVodPlayer.prototype._videoCurrent = function () {
    return (this.transcodeBase || 0) + (this.video.currentTime || 0);
  };
  CloudVodPlayer.prototype._refreshProgressUI = function () {
    var dur = this._effectiveDuration();
    var ratio = dur > 0 ? clamp(this._videoCurrent() / dur, 0, 1) : 0;
    this.progressPlayed.style.width = (ratio * 100) + '%';
    this.progressThumb.style.left = (ratio * 100) + '%';
    if (dur > 0) this.timeText.textContent = fmtTime(this._videoCurrent()) + ' / ' + fmtTime(dur);
    if (dur > 0 && this.video.buffered.length) {
      var end = this.video.buffered.end(this.video.buffered.length - 1);
      this.progressBuffer.style.width = clamp(end / dur, 0, 1) * 100 + '%';
    }
    this._updateTranscodeHint();
  };
  CloudVodPlayer.prototype._updateTranscodeHint = function () {
    if (this.transcodeDone || !this.knownDuration) { this.transcodeHint.classList.remove('on'); return; }
    var cur = this._videoCurrent() || 0;
    if (cur > this.transcodedSec + 1) {
      this.transcodeHint.textContent = '转码中 ' + fmtTime(this.transcodedSec);
      this.transcodeHint.classList.add('on');
    } else {
      this.transcodeHint.classList.remove('on');
    }
  };
  CloudVodPlayer.prototype._setFmtTag = function (fmt) {
    var map = { native: 'MP4', hls: 'M3U8', transcode: '转码' };
    this.fmtTag.textContent = map[fmt] || fmt.toUpperCase();
  };
  CloudVodPlayer.prototype._showLoading = function () { this.idleBox.hidden = true; this.errorBox.hidden = true; this.loadingBox.hidden = false; };
  CloudVodPlayer.prototype._hideLoading = function () { this.loadingBox.hidden = true; this.idleBox.hidden = true; };
  CloudVodPlayer.prototype._showError = function (title, text) {
    this.loadingBox.hidden = true; this.idleBox.hidden = true;
    this.errorTitle.textContent = title; this.errorText.textContent = text;
    this.errorBox.hidden = false;
    this._emit('error', { title: title, text: text });
  };
  CloudVodPlayer.prototype._setPlaying = function (p) {
    this.playing = p;
    this.iconPlay.classList.toggle('hide', !p);
    this.iconPause.classList.toggle('hide', p);
    this.bigPlay.hidden = p || !this.video.src;
    this.stage.classList.toggle('playing', p);
    if (p) this._scheduleHide(); else this._showControls();
    this._emit(p ? 'play' : 'pause');
  };
  CloudVodPlayer.prototype._showControls = function () { this.stage.classList.add('controls-on'); clearTimeout(this.hideTimer); };
  CloudVodPlayer.prototype._scheduleHide = function () {
    this.stage.classList.add('controls-on');
    clearTimeout(this.hideTimer);
    var self = this;
    this.hideTimer = setTimeout(function () { self.stage.classList.remove('controls-on'); }, 2800);
  };
  CloudVodPlayer.prototype._resetProgress = function () {
    this.progressPlayed.style.width = '0%';
    this.progressBuffer.style.width = '0%';
    this.progressThumb.style.left = '0%';
    this.progressTranscoded.style.width = '0%';
    this.progressTranscoded.hidden = true;
    this.transcodeHint.classList.remove('on');
    this.timeText.textContent = '00:00 / 00:00';
  };
  // 容器自适应视频原始比例：设置用户容器（Shadow DOM 宿主）的 aspect-ratio，
  // Shadow DOM 内部 .player-stage 为 width:100%;height:100% 自动填满。
  // 切换视频时重置为空，恢复用户在 HTML/CSS 中设置的默认比例（通常 16:9）。
  CloudVodPlayer.prototype._setContainerRatio = function (w, h) {
    if (w > 0 && h > 0 && this.container) {
      this.container.style.aspectRatio = w + ' / ' + h;
    }
  };
  CloudVodPlayer.prototype._resetContainerRatio = function () {
    if (this.container) this.container.style.aspectRatio = '';
  };
  CloudVodPlayer.prototype._stopExisting = function () {
    this._stopHoldAlive();
    if (this.hls) { try { this.hls.destroy(); } catch (e) {} this.hls = null; }
    try { this.video.removeAttribute('src'); this.video.load(); } catch (e) {}
  };
  CloudVodPlayer.prototype._startHoldAlive = function () {
    if (this.holdTimer || !this.transcodeSid) return;
    var self = this;
    this.holdTimer = setInterval(function () {
      if (!self.transcodeSid) { self._stopHoldAlive(); return; }
      fetch(self._api('/api/ping?sid=' + encodeURIComponent(self.transcodeSid))).catch(function () {});
    }, 30000);
  };
  CloudVodPlayer.prototype._stopHoldAlive = function () {
    if (this.holdTimer) { clearInterval(this.holdTimer); this.holdTimer = null; }
  };
  CloudVodPlayer.prototype._togglePlay = function () {
    if (this.seeking) return;   // 跳转中忽略暂停/播放，避免与新会话的自动 play() 竞态导致无法播放
    if (!this.video.src) return;
    if (this.video.paused) this.play(); else this.video.pause();
  };
  CloudVodPlayer.prototype._toggleFullscreen = function () {
    if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
    else this.stage.requestFullscreen().catch(function () {});
  };
  CloudVodPlayer.prototype._updateMuteUI = function () {
    var muted = this.video.muted || this.video.volume === 0;
    this.iconVol.classList.toggle('hide', muted);
    this.iconMuted.classList.toggle('hide', !muted);
    if (!this.video.muted) this.volRange.value = Math.round(this.video.volume * 100);
  };

  /* ---------- 事件绑定 ---------- */
  CloudVodPlayer.prototype._bindEvents = function () {
    var self = this;

    // 进度条拖拽
    this.progressRow.addEventListener('pointerdown', function (e) {
      if (!self.video.src) return;
      self.scrubbing = true;
      self.progress.classList.add('scrubbing');
      self.progressRow.setPointerCapture(e.pointerId);
      self._seekFromEvent(e);
    });
    this.progressRow.addEventListener('pointermove', function (e) { if (self.scrubbing) self._seekFromEvent(e); });
    function endScrub(e) {
      if (!self.scrubbing) return;
      self.scrubbing = false;
      self.progress.classList.remove('scrubbing');
      try { self.progressRow.releasePointerCapture(e.pointerId); } catch (err) {}
      self._doSeek(self.pendingSeekT);
    }
    this.progressRow.addEventListener('pointerup', endScrub);
    this.progressRow.addEventListener('pointercancel', endScrub);

    // video 事件
    this.video.addEventListener('loadedmetadata', function () {
      self._hideLoading();
      self._setContainerRatio(self.video.videoWidth, self.video.videoHeight);   // 容器自适应视频原始比例
      var dur = self._effectiveDuration();
      if (dur > 0) self.timeText.textContent = fmtTime(self._videoCurrent()) + ' / ' + fmtTime(dur);
      self._emit('ready');
    });
    this.video.addEventListener('durationchange', function () {
      var dur = self._effectiveDuration();
      if (dur > 0) self.timeText.textContent = fmtTime(self._videoCurrent()) + ' / ' + fmtTime(dur);
    });
    this.video.addEventListener('timeupdate', function () {
      if (self.scrubbing) return;
      self._refreshProgressUI();
      self._emit('timeupdate', self._videoCurrent());
    });
    this.video.addEventListener('progress', function () {
      var dur = self._effectiveDuration();
      if (dur > 0 && self.video.buffered.length) {
        var end = self.video.buffered.end(self.video.buffered.length - 1);
        self.progressBuffer.style.width = clamp(end / dur, 0, 1) * 100 + '%';
      }
    });
    this.video.addEventListener('playing', function () {
      if (self.waitTimer) { clearTimeout(self.waitTimer); self.waitTimer = null; }
      self.seeking = false;   // 真正开始播放，清除跳转中标志位，恢复暂停/播放操作
      self._hideLoading(); self._setPlaying(true); self._stopHoldAlive();
    });
    this.video.addEventListener('waiting', function () {
      if (self.waitTimer) return;
      self.waitTimer = setTimeout(function () { self.waitTimer = null; self._showLoading(); }, 350);
    });
    this.video.addEventListener('seeked', function () {
      if (self.waitTimer) { clearTimeout(self.waitTimer); self.waitTimer = null; }
    });
    this.video.addEventListener('pause', function () { self._setPlaying(false); self._showControls(); self._startHoldAlive(); });
    this.video.addEventListener('ended', function () {
      self._setPlaying(false); self._showControls(); self._stopHoldAlive();
      self._emit('ended');
    });
    this.video.addEventListener('error', function () {
      if (!self.currentUrl) return;
      var code = self.video.error ? self.video.error.code : 0;
      var text = code === 4 ? '该视频格式或编码不被浏览器支持，或链接已失效。'
        : code === 2 ? '网络错误，无法加载该视频。'
        : code === 3 ? '视频解码失败。'
        : code === 1 ? '播放被中止。'
        : '未知错误，无法播放该视频。';
      self._showError('无法播放该视频', text);
      self._setPlaying(false);
    });

    // 控制按钮
    this.playPauseBtn.addEventListener('click', function (e) { e.stopPropagation(); self._togglePlay(); });
    this.bigPlay.addEventListener('click', function (e) { e.stopPropagation(); self._togglePlay(); });
    this.stage.addEventListener('click', function (e) {
      if (e.target.closest('.controls')) return;
      if (self.video.src) self._togglePlay();
    });
    this.stage.addEventListener('dblclick', function (e) {
      if (e.target.closest('.controls')) return;
      self._toggleFullscreen();
    });
    this.muteBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      self.video.muted = !self.video.muted;
      self._updateMuteUI();
    });
    this.volRange.addEventListener('input', function () {
      self.video.muted = false;
      self.video.volume = self.volRange.value / 100;
      self._updateMuteUI();
    });
    this.rateSel.addEventListener('change', function () { self.video.playbackRate = parseFloat(self.rateSel.value); });
    this.pipBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (document.pictureInPictureElement) document.exitPictureInPicture().catch(function () {});
      else self.video.requestPictureInPicture().catch(function () {});
    });
    this.fsBtn.addEventListener('click', function (e) { e.stopPropagation(); self._toggleFullscreen(); });
    document.addEventListener('fullscreenchange', function () {
      if (document.fullscreenElement) self.stage.classList.add('controls-lock');
      else self.stage.classList.remove('controls-lock');
    });

    // 键盘快捷键（播放器聚焦时）
    this.stage.addEventListener('keydown', function (e) {
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (e.code === 'Space') { e.preventDefault(); self._togglePlay(); }
      else if (e.code === 'ArrowRight') { e.preventDefault(); self._doSeek(Math.min(self._effectiveDuration(), self._videoCurrent() + 5)); }
      else if (e.code === 'ArrowLeft') { e.preventDefault(); self._doSeek(Math.max(0, self._videoCurrent() - 5)); }
      else if (e.code === 'ArrowUp') { e.preventDefault(); self.video.volume = clamp(self.video.volume + 0.1, 0, 1); self.video.muted = false; self._updateMuteUI(); }
      else if (e.code === 'ArrowDown') { e.preventDefault(); self.video.volume = clamp(self.video.volume - 0.1, 0, 1); self._updateMuteUI(); }
      else if (e.code === 'KeyF') self._toggleFullscreen();
      else if (e.code === 'KeyM') { self.video.muted = !self.video.muted; self._updateMuteUI(); }
    });
  };

  /* ==================== 自动初始化（扫描 [data-cloud-vod] 元素） ==================== */
  function autoInit() {
    var els = document.querySelectorAll('[data-cloud-vod]');
    for (var i = 0; i < els.length; i++) {
      (function (el) {
        if (el.__cvpInited) return;
        el.__cvpInited = true;
        var opts = {
          url: el.getAttribute('data-url') || '',
          autoplay: el.getAttribute('data-autoplay') === 'true',
          muted: el.getAttribute('data-muted') === 'true',
          theme: {}
        };
        var primary = el.getAttribute('data-theme-primary');
        if (primary) opts.theme.primary = primary;
        var radius = el.getAttribute('data-theme-radius');
        if (radius) opts.theme.radius = radius;
        el.__cvpInstance = new CloudVodPlayer(el, opts);
      })(els[i]);
    }
  }

  /* ==================== 暴露全局 ==================== */
  global.CloudVodPlayer = CloudVodPlayer;

  // DOM 就绪后自动初始化声明式实例
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoInit);
  } else {
    autoInit();
  }

})(window);
