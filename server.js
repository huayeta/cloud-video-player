#!/usr/bin/env node
/**
 * 云点播 · 本地媒体服务器
 *
 * 功能：
 *  1. 静态托管 public/ 播放器页面
 *  2. /api/probe   —— 探测远程视频格式，决定播放策略（native 代理 / HLS / FLV / 转码）
 *  3. /api/proxy   —— 原生支持格式（mp4/webm/ogg/mov…）反向代理，透传 Range 请求：
 *                      实现秒开 + 任意拖拽进度，并绕开跨域(CORS)限制
 *  4. /api/transcode —— avi/mkv/rmvb/wmv/mpeg… 等浏览器不支持的格式，
 *                       用 ffmpeg 实时转码为 HLS 流（边转边播、分片可 seek）
 *  5. /hls/<sid>/*  —— 提供转码产生的 m3u8 与 ts 分片（分片未就绪时自动等待）
 *
 * 启动：node server.js  （默认端口 8787，可用 PORT 环境变量覆盖）
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const TMP = path.join(ROOT, 'tmp');

/* ---- 配置文件加载 ----
 * 优先读取 config.json（用户实际配置）；不存在则用代码默认值。
 * 环境变量 PORT / MAX_CACHE_MB 仍可临时覆盖对应项。
 */
const DEFAULTS = {
  port: 8787,
  ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  hlsTime: 6,          // 转码 HLS 分片秒数
  hlsInitTime: 2,      // 关键帧间隔基准（秒），同时需能整除 hlsTime（系统取两者最大公约数）
  audioBitrateK: 160,  // 音频码率 kbps
  x264Preset: 'veryfast',
  x264Crf: 23,
  tsCacheMaxAge: 3600, // ts 分片浏览器缓存秒数
  maxCacheMB: 2048,    // tmp 缓存总配额 MB
  idleTranscodeTimeoutSec: 60, // 空闲转码回收阈值（秒）
  quotaScanSec: 60,    // 缓存配额扫描间隔（秒）
  maxConcurrent: 3     // 同时转码的 ffmpeg 进程上限（防 CPU/内存被打爆）
};
let CFG = {};
try { CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); }
catch (e) { CFG = {}; }
// 仅取已知键（忽略 config 里的 _说明_ / _comment_* 等辅助字段）
CFG = Object.keys(DEFAULTS).reduce((o, k) => { o[k] = CFG[k] !== undefined ? CFG[k] : DEFAULTS[k]; return o; }, {});
const PORT = CFG.port;
const UA = CFG.ua;

// 转码会话：sid -> { dir, proc, name, createdAt, lastAccess }
const sessions = new Map();

if (!fs.existsSync(PUBLIC)) fs.mkdirSync(PUBLIC, { recursive: true });
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

/* ================= 小工具 ================= */

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sendText(res, code, text, type) {
  res.writeHead(code, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(text);
}

function safeURL(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u;
  } catch (e) { return null; }
}

function extOf(url) {
  try {
    const p = new URL(url).pathname.toLowerCase();
    const m = p.match(/\.([a-z0-9]+)$/);
    return m ? m[1] : '';
  } catch (e) { return ''; }
}

function baseName(url) {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean);
    return seg.length ? seg[seg.length - 1].slice(0, 60) : u.host;
  } catch (e) { return 'remote'; }
}

function countSegments(dir) {
  try {
    const files = fs.readdirSync(dir);
    return files.filter((f) => /^seg_\d+\.ts$/.test(f)).length;
  } catch (e) { return 0; }
}

/* ================= 探测 ================= */

// 浏览器可直接播放的视频编码
const NATIVE_VIDEO_CODECS = ['h264', 'vp8', 'vp9', 'av1', 'mjpeg'];
const NATIVE_AUDIO_CODECS = ['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le'];
const NATIVE_EXTS = ['mp4', 'm4v', 'mov', 'webm', 'ogg', 'ogv', 'oga', 'opus', 'mp3', 'aac', 'wav', 'm4a'];
const TRANSCODE_EXTS = ['avi', 'mkv', 'rmvb', 'rm', 'wmv', 'mpeg', 'mpg', 'vob', 'ts', 'm2ts', 'asf', '3gp'];

function detectByExt(url) {
  const ext = extOf(url);
  if (!ext) return 'unknown';
  if (ext === 'm3u8') return 'hls';
  if (ext === 'flv') return 'flv';
  if (NATIVE_EXTS.includes(ext)) return 'native';
  if (TRANSCODE_EXTS.includes(ext)) return 'transcode';
  return 'unknown';
}

// ffprobe 探测远程流编码
function probeWithFFprobe(url, cb) {
  const args = [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,width,height:format=format_name,duration',
    '-of', 'json',
    url
  ];
  execFile('ffprobe', args, { timeout: 20000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
    if (err) return cb(null);
    try {
      const data = JSON.parse(stdout);
      const stream = data.streams && data.streams[0];
      const fmt = data.format || {};
      if (stream && stream.codec_name) {
        return cb({
          vcodec: stream.codec_name,
          container: fmt.format_name || '',
          duration: fmt.duration || null
        });
      }
      return cb(null);
    } catch (e) { return cb(null); }
  });
}

/**
 * 综合探测，返回 { mode, name, vcodec, container }
 * mode: native | hls | flv | transcode
 */
function probe(url) {
  const byExt = detectByExt(url);
  return new Promise((resolve) => {
    // 扩展名明确 → 直接决定（不再等待 ffprobe，保证秒回）
    if (byExt === 'hls') return resolve({ mode: 'hls', name: baseName(url) });
    if (byExt === 'flv') return resolve({ mode: 'flv', name: baseName(url) });
    if (byExt === 'native') return resolve({ mode: 'native', name: baseName(url) });
    if (byExt === 'transcode') return resolve({ mode: 'transcode', name: baseName(url) });

    // 扩展名未知/无扩展名 → ffprobe 嗅探
    probeWithFFprobe(url, (info) => {
      if (!info) {
        return resolve({ mode: 'native', name: baseName(url), probe: false });
      }
      const vc = info.vcodec || '';
      const container = info.container || '';
      // 容器支持且编码支持 → 原生代理
      const okContainer = /mp4|mov|matroska?|webm|ogg|mpegts?|quicktime/i.test(container);
      if (okContainer && NATIVE_VIDEO_CODECS.includes(vc)) {
        return resolve({ mode: 'native', name: baseName(url), vcodec: vc, container });
      }
      // h265/hevc 在支持的容器里浏览器大多也能解（视浏览器而定），其余一律转码
      return resolve({ mode: 'transcode', name: baseName(url), vcodec: vc, container });
    });
  });
}

/* ================= 原生代理（透传 Range） ================= */

function proxyStream(req, res, targetURL) {
  const u = safeURL(targetURL);
  if (!u) return sendText(res, 400, 'bad url');

  const mod = u.protocol === 'https:' ? https : http;
  const headers = {
    'User-Agent': UA,
    'Accept': '*/*',
    'Connection': 'keep-alive'
  };
  if (req.headers.range) headers['Range'] = req.headers.range;

  const preq = mod.request(u, {
    method: 'GET',
    headers
  }, (pres) => {
    const outHeaders = {
      'Content-Type': pres.headers['content-type'] || 'application/octet-stream',
      'Accept-Ranges': pres.headers['accept-ranges'] || 'bytes',
      'Cache-Control': 'no-store'
    };
    if (pres.headers['content-length']) outHeaders['Content-Length'] = pres.headers['content-length'];
    if (pres.headers['content-range']) outHeaders['Content-Range'] = pres.headers['content-range'];
    res.writeHead(pres.statusCode || 200, outHeaders);
    pres.pipe(res);
  });
  preq.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('proxy error');
  });
  // 客户端断开时销毁源站请求，避免 keep-alive 连接悬挂泄漏
  res.on('close', () => { if (!res.writableEnded) preq.destroy(); });
  req.on('aborted', () => preq.destroy());
  preq.end();
}

/* ================= 转码为 HLS ================= */

const TRANSCODE_HLS_TIME = CFG.hlsTime; // 目标分片秒数，来自 config.json
const HLS_INIT_TIME = CFG.hlsInitTime != null ? CFG.hlsInitTime : 2; // 首个分片秒数：越小起播越快（默认2秒）
// 关键帧间隔 = gcd(hls_time, init_time)：保证首片边界与后续分片边界都落在关键帧上，
// 这样 -hls_init_time 才能真正切出更短的第一个分片（否则首片会被首个关键帧位置拖长）
function gcd(a, b) { while (b) { const t = a % b; a = b; b = t; } return a; }
const KEYFRAME_INTERVAL = gcd(TRANSCODE_HLS_TIME, HLS_INIT_TIME);
const AUDIO_BITRATE = CFG.audioBitrateK + 'k';
const X264_PRESET = CFG.x264Preset;
const X264_CRF = CFG.x264Crf;

function buildFFmpegArgs(url, dir, copy, startSec) {
  const segPattern = path.join(dir, 'seg_%03d.ts');
  const playlist = path.join(dir, 'index.m3u8');
  const base = [
    '-y',
    '-headers', 'User-Agent: ' + UA + '\r\nReferer: ' + new URL(url).origin + '\r\n',
    // 限制输入探测耗时/数据量：慢源站打开更快（默认探测 5 秒/5MB，对远程大文件过重）
    '-analyzeduration', '2000000',
    '-probesize', '2000000',
    '-fflags', '+genpts'
  ];
  // 从指定秒数开始转码（拖动到未转区时使用）：-ss 放在 -i 前为快速 seek
  if (startSec > 0) base.push('-ss', String(startSec));
  base.push('-i', url);
  let videoArgs, audioArgs;
  if (copy) {
    // 源已是 h264：视频流拷贝（remux，极快），音频统一转 aac 保证 ts 封装兼容
    videoArgs = ['-c:v', 'copy'];
    audioArgs = ['-c:a', 'aac', '-b:a', AUDIO_BITRATE];
  } else {
    // 强制每 KEYFRAME_INTERVAL 秒一个关键帧：让 HLS 分片均匀、首片可快切、拖动进度精确
    videoArgs = ['-c:v', 'libx264', '-preset', X264_PRESET, '-crf', String(X264_CRF), '-g', String(KEYFRAME_INTERVAL * 60), '-force_key_frames', 'expr:gte(t,n_forced*' + KEYFRAME_INTERVAL + ')'];
    audioArgs = ['-c:a', 'aac', '-b:a', AUDIO_BITRATE];
  }
  const tail = [
    '-f', 'hls',
    '-hls_time', String(TRANSCODE_HLS_TIME),
    '-hls_list_size', '0',          // 保留全部分片，支持向已转区域任意拖动
    '-hls_flags', 'independent_segments',
    '-hls_segment_filename', segPattern,
    playlist
  ];
  return base.concat(videoArgs, audioArgs, tail);
}

/* 挂载 ffmpeg 进程事件与进度解析（startTranscode / seekTranscode 共用） */
function attachFfmpegHandlers(session, proc, dir) {
  let errBuf = '';
  proc.stderr.on('data', (d) => {
    // seekTranscode 替换进程后，旧进程的 stderr 缓冲数据可能晚到：
    // 只有当前活跃进程的数据才更新会话状态，防止旧进度覆盖新进度
    if (proc !== session.proc) return;
    const s = d.toString();
    errBuf += s;
    // 解析输入流编码（ffmpeg 打开输入即打印）：仅作诊断/记录。
    // 【重要】copy 自动切换已禁用：实测 -c:v copy 直接输出 HLS 时，
    // muxer 无法可靠计算分片时长（EXTINF=0），会导致 hls.js 无法播放、进度不推进。
    // 因此统一走 libx264 全转码（慢但分片稳定可播）。
    if (session.inputVcodec === undefined) {
      if (errBuf.includes('Stream mapping')) {
        const i0 = errBuf.indexOf('Input #0');
        if (i0 !== -1) {
          const part = errBuf.slice(i0, errBuf.indexOf('Stream mapping', i0));
          const m = /Stream #0:\d[^\n]*: Video: (\w+)/.exec(part);
          session.inputVcodec = m ? m[1] : null;
        } else {
          session.inputVcodec = null;
        }
      }
    }
    // ffmpeg 打开输入后立即打印 Duration: HH:MM:SS.xx —— 解析为总时长（秒）
    if (session.duration === null) {
      const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s);
      if (m) {
        session.duration = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
      }
    }
    // ffmpeg 进度行含 time=HH:MM:SS.xx —— 解析为"已转码到"的时间点（用于进度条展示转码范围）
    // 行内最后一个 time= 是当前输出时间戳（相对 startSec 的输出起点）
    const idx = s.lastIndexOf('time=');
    if (idx !== -1) {
      const tseg = s.slice(idx + 5, idx + 20).match(/^(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (tseg) {
        session.transcoded = parseInt(tseg[1], 10) * 3600 + parseInt(tseg[2], 10) * 60 + parseFloat(tseg[3]);
      }
    }
  });

  proc.on('error', (e) => {
    session.error = '无法启动 ffmpeg：' + e.message;
    session.closed = true;   // 标记已结束，使 scheduleCleanup 能正常清理（spawn 失败时 exitCode 可能为 null）
    scheduleCleanup(session.sid, 3000);
  });
  proc.on('close', (code) => {
    // 被 seekTranscode 主动替换的进程：关闭属预期，不当作异常
    if (proc._replaced) return;
    session.closed = true;
    if (code !== 0 && !fs.existsSync(path.join(dir, 'index.m3u8'))) {
      session.error = '转码异常退出(' + code + ')：' + (errBuf.slice(-500) || '未知错误');
    }
    // 进程结束后延迟清理（给播放器留足拉片时间）
    scheduleCleanup(session.sid, 10 * 60 * 1000);
  });
}

function startTranscode(url, startSec) {
  const sid = crypto.randomBytes(6).toString('hex');
  const dir = path.join(TMP, sid);
  fs.mkdirSync(dir, { recursive: true });
  startSec = startSec || 0;

  // 直接用 libx264 全转码（不先探测，避免 AVI 远程探测耗时导致超时）
  // 启动后后台快速探测源编码：若是 h264，自动切换为 copy（视频流 remux）以大幅提速
  const args = buildFFmpegArgs(url, dir, false, startSec);
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });

  const session = { sid, dir, url, proc, name: baseName(url), createdAt: Date.now(), lastAccess: Date.now(), copy: false, duration: null, transcoded: 0, started: Date.now(), startSec, inputVcodec: undefined };
  sessions.set(sid, session);
  attachFfmpegHandlers(session, proc, dir);

  return session;
}


/* 跳转到未转码区域：复用同一会话/缓存目录，停止旧 ffmpeg、清空旧分片，
 * 从目标位置重新转码。避免每次跳转都新建目录。 */
function seekTranscode(sid, to) {
  const s = sessions.get(sid);
  if (!s) return null;
  // 停止当前转码进程（标记为被替换，避免误报异常）
  if (s.proc) { try { s.proc._replaced = true; s.proc.kill('SIGKILL'); } catch (e) {} }
  // 清空该会话目录中的旧分片与清单（同一目录复用，避免旧文件残留）
  try {
    for (const f of fs.readdirSync(s.dir)) {
      if (f.endsWith('.ts') || f === 'index.m3u8') {
        fs.unlinkSync(path.join(s.dir, f));
      }
    }
  } catch (e) {}
  // 重置会话状态，从新位置转码
  s.startSec = Math.max(0, to || 0);
  s.duration = null;
  s.transcoded = 0;
  s.error = null;
  s.closed = false;
  s.lastAccess = Date.now();
  const args = buildFFmpegArgs(s.url, s.dir, !!s.copy, s.startSec);
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  s.proc = proc;
  attachFfmpegHandlers(s, proc, s.dir);
  return s;
}

function cleanupSession(sid) {
  const s = sessions.get(sid);
  if (!s) return;
  sessions.delete(sid);
  try { s.proc && s.proc.kill('SIGKILL'); } catch (e) {}
  // 延迟删除目录，避免正在被读取的文件被删
  setTimeout(() => {
    fs.rm(s.dir, { recursive: true, force: true }, () => {});
  }, 30000);
}

function scheduleCleanup(sid, ms) {
  setTimeout(() => {
    const s = sessions.get(sid);
    // 仅在"转码已结束"且"播放器已不再活跃（5 分钟内无拉流）"时才清理，
    // 避免误删仍在播放/暂停保活的会话目录导致播放中断。
    if (s && (!s.proc || s.proc.killed || s.proc.exitCode !== null)) {
      if (Date.now() - s.lastAccess > 5 * 60 * 1000) {
        cleanupSession(sid);
      } else {
        scheduleCleanup(sid, 5 * 60 * 1000);   // 播放器仍活跃，延长再查
      }
    }
  }, ms);
}

/* ---- 磁盘配额管理 ----
 * tmp 转码缓存总量设上限（默认 2GB，可用环境变量 MAX_CACHE_MB 覆盖），
 * 防止播放大量视频后 tmp 无限膨胀耗尽磁盘。
 * 每 60 秒扫描：超限时从最不活跃的会话开始清理（跳过正在拉流的会话），
 * 包括 sessions 中已结束的会话与孤儿目录（进程残留）。
 */
const MAX_CACHE_BYTES = (parseInt(process.env.MAX_CACHE_MB, 10) || CFG.maxCacheMB) * 1024 * 1024;
const QUOTA_SCAN_MS = CFG.quotaScanSec * 1000;
const QUOTA_SKIP_LIVE_MS = 30 * 1000;  // 30 秒内有拉流的会话视为正在播放，不打断

function dirSize(p) {
  let total = 0;
  try {
    for (const f of fs.readdirSync(p, { withFileTypes: true })) {
      const fp = path.join(p, f.name);
      total += f.isDirectory() ? dirSize(fp) : (fs.statSync(fp).size || 0);
    }
  } catch (e) {}
  return total;
}

function enforceCacheQuota() {
  let entries;
  try { entries = fs.readdirSync(TMP, { withFileTypes: true }); } catch (e) { return; }
  const dirs = [];
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    const dir = path.join(TMP, d.name);
    const s = sessions.get(d.name);
    let mtime = 0;
    try { mtime = fs.statSync(dir).mtimeMs || 0; } catch (e) {}
    dirs.push({
      sid: d.name,
      dir,
      size: dirSize(dir),
      lastAccess: s ? s.lastAccess : mtime,   // 孤儿目录用目录 mtime
      isLive: s ? (Date.now() - s.lastAccess < QUOTA_SKIP_LIVE_MS) : false
    });
  }
  let total = dirs.reduce((a, d) => a + d.size, 0);
  if (total <= MAX_CACHE_BYTES) return;
  console.log('[quota] tmp 缓存超限 ' + (total / 1048576).toFixed(0) + 'MB > ' + (MAX_CACHE_BYTES / 1048576).toFixed(0) + 'MB，清理最不活跃会话');
  // 从最不活跃的开始清理，跳过正在拉流的会话
  dirs.sort((a, b) => a.lastAccess - b.lastAccess);
  for (const d of dirs) {
    if (total <= MAX_CACHE_BYTES) break;
    if (d.isLive) continue;
    if (sessions.has(d.sid)) {
      console.log('[quota] 清理会话缓存:', d.sid, '（' + (d.size / 1048576).toFixed(0) + 'MB，' + Math.round((Date.now() - d.lastAccess) / 1000) + ' 秒前活跃）');
      cleanupSession(d.sid);
    } else {
      console.log('[quota] 清理孤儿缓存:', d.sid, '（' + (d.size / 1048576).toFixed(0) + 'MB）');
      fs.rm(d.dir, { recursive: true, force: true }, () => {});
    }
    total -= d.size;
  }
  console.log('[quota] 清理后 tmp 约 ' + (dirSize(TMP) / 1048576).toFixed(0) + 'MB');
}
setInterval(enforceCacheQuota, QUOTA_SCAN_MS);

/* ---- 空闲会话自动回收 ----
 * 转码中的会话，如果播放器已停止拉流（hls.js 被销毁 / 页面切换 / 关闭），
 * 长时间没有 m3u8/ts 请求（lastAccess 不再更新），则自动终止 ffmpeg，
 * 避免"不再播放的视频仍在后台缓存"。
 * 注意：/api/status 轮询不更新 lastAccess，防止残留轮询阻止回收。
 */
const IDLE_TRANSCODE_TIMEOUT = CFG.idleTranscodeTimeoutSec * 1000; // 来自 config.json，无拉流即视为播放器已离开

/* 统计当前正在转码（ffmpeg 进程存活）的会话数 */
function activeTranscodeCount() {
  let n = 0;
  for (const s of sessions.values()) {
    if (s.proc && !s.proc.killed && s.proc.exitCode === null) n++;
  }
  return n;
}
setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) {
    if (!s || s.closed) continue;
    // 只回收"仍在转码"的会话（proc 活着）；已结束的走原 scheduleCleanup
    if (!s.proc || s.proc.killed || s.proc.exitCode !== null) continue;
    if (now - s.lastAccess > IDLE_TRANSCODE_TIMEOUT) {
      console.log('[gc] 播放器已离开，终止空闲转码:', sid, '（' + Math.round((now - s.lastAccess) / 1000) + ' 秒无拉流）');
      cleanupSession(sid);
    }
  }
}, 15000);

/* ================= HTTP 服务 ================= */

function handleStreamFile(req, res, sid, rel) {
  const s = sessions.get(sid);
  if (!s) return sendText(res, 404, 'session not found');
  s.lastAccess = Date.now();
  const file = path.join(s.dir, rel);
  // 防目录穿越
  if (!file.startsWith(s.dir)) return sendText(res, 403, 'forbidden');

  // ffmpeg 已异常退出且没有产出 → 直接报错
  if (s.error && !fs.existsSync(file)) {
    return sendText(res, 502, s.error);
  }

  const ext = path.extname(file).toLowerCase();
  let type = 'application/octet-stream';
  if (ext === '.m3u8') type = 'application/vnd.apple.mpegurl';
  else if (ext === '.ts') type = 'video/mp2t';

  // 分片可能尚未生成（慢源站/首片转码耗时较长）：轮询等待。
  // 等待时长必须 < hls.js 的 manifestLoadingTimeOut（转码场景 60s），
  // 否则 hls.js 会先超时取消请求（表现为"第一个 m3u8 已取消，重新请求一个"）。
  // 45s 覆盖大多数慢源首片时间（如 1.avi 约 28s），极端慢源才返回 404 让 hls.js 重试。
  const waitMs = 45000;
  const start = Date.now();
  let aborted = false;
  // 客户端断开（切换视频/关闭标签/hls.js 超时取消）时立即停止等待，避免 serve 循环空转最多 45 秒
  res.on('close', () => { aborted = true; });
  (function serve() {
    if (aborted) return;
    if (!sessions.has(sid)) return sendText(res, 404, 'session gone');
    if (s.error && !fs.existsSync(file)) {
      return sendText(res, 502, s.error);
    }
    fs.stat(file, (err, st) => {
      if (aborted) return;
      if (!err) {
        // m3u8 动态增长（ffmpeg 持续写入）：不设 Content-Length，走 chunked，
        // 避免 stat 快照与实际内容不符导致 hls.js 拿到不完整清单；
        // ts 分片转码后不可变 → 允许缓存 + Content-Length。
        const cacheCtrl = ext === '.ts' ? 'public, max-age=' + CFG.tsCacheMaxAge : 'no-store';
        const headers = {
          'Content-Type': type,
          'Cache-Control': cacheCtrl
        };
        if (ext === '.ts') headers['Content-Length'] = st.size;
        res.writeHead(200, headers);
        fs.createReadStream(file).pipe(res);
        return;
      }
      if (Date.now() - start > waitMs) return sendText(res, 404, 'not ready yet');
      setTimeout(serve, 600);
    });
  })();
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  // 轻量请求日志：统计 /hls/ 与 /api/ 请求，用于观察播放与转码会话生命周期
  if (p.startsWith('/hls/') || p.startsWith('/api/')) {
    console.log('[req]', new Date().toISOString().slice(11, 19), p + (u.search || ''));
  }
  /* ---- API：探测 ---- */
  if (p === '/api/probe') {
    const url = u.searchParams.get('url') || '';
    if (!safeURL(url)) return sendJSON(res, 400, { error: 'invalid url' });
    probe(url).then((info) => sendJSON(res, 200, info));
    return;
  }

  /* ---- API：原生代理 ---- */
  if (p === '/api/proxy') {
    const url = u.searchParams.get('url') || '';
    if (!safeURL(url)) return sendJSON(res, 400, { error: 'invalid url' });
    proxyStream(req, res, url);
    return;
  }

  /* ---- API：HLS 代理（递归重写 m3u8，绕开 CORS） ---- */
  if (p === '/api/hlsproxy') {
    const url = u.searchParams.get('url') || '';
    const tu = safeURL(url);
    if (!tu) return sendJSON(res, 400, { error: 'invalid url' });
    const mod = tu.protocol === 'https:' ? https : http;
    const greq = mod.request(tu, { method: 'GET', headers: { 'User-Agent': UA, 'Accept': '*/*' } }, (gpres) => {
      if (gpres.statusCode !== 200 && gpres.statusCode !== 206) {
        gpres.resume();
        return sendText(res, 502, 'hls upstream error: ' + gpres.statusCode);
      }
      let body = '';
      gpres.setEncoding('utf8');
      gpres.on('data', (d) => { body += d; });
      gpres.on('end', () => {
        // 把 m3u8 中的资源行改写为本地代理地址
        // - 紧跟在 #EXT-X-STREAM-INF 之后的 variant playlist → 改写为 /api/hlsproxy（递归）
        // - 其余媒体分片（ts/mp4/segment） → 改写为 /api/proxy
        const base = tu.origin + tu.pathname.substring(0, tu.pathname.lastIndexOf('/') + 1);
        const lines = body.split('\n');
        let prevWasStreamInf = false;
        const out = lines.map((line) => {
          const t = line.trim();
          if (t.startsWith('#')) {
            prevWasStreamInf = /^#EXT-X-STREAM-INF:/.test(t);
            return line;
          }
          if (!t) { prevWasStreamInf = false; return line; }
          let segUrl;
          try { segUrl = new URL(t, base).href; } catch (e) { prevWasStreamInf = false; return line; }
          const isVariant = prevWasStreamInf;
          prevWasStreamInf = false;
          const enc = encodeURIComponent(segUrl);
          return '/api/' + (isVariant ? 'hlsproxy?url=' : 'proxy?url=') + enc;
        }).join('\n');
        res.writeHead(200, {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'no-store'
        });
        res.end(out);
      });
    });
    greq.on('error', () => { if (!res.headersSent) sendText(res, 502, 'hls upstream error'); });
    // 客户端断开时销毁源站请求，避免连接悬挂
    res.on('close', () => { if (!res.writableEnded) greq.destroy(); });
    req.on('aborted', () => greq.destroy());
    greq.end();
    return;
  }

  /* ---- API：暂停保活（播放器暂停时定期调用，阻止自动回收终止转码缓存） ---- */
  if (p === '/api/ping') {
    const sid = u.searchParams.get('sid') || '';
    const s = sessions.get(sid);
    if (!s) return sendJSON(res, 404, { error: 'session not found' });
    s.lastAccess = Date.now();   // 刷新"最后拉流时间"，使空闲回收计时重置
    sendJSON(res, 200, { ok: true });
    return;
  }

  /* ---- API：终止转码会话（切换/停止播放时停止后台转码，释放 CPU） ---- */
  if (p === '/api/stop') {
    const sid = u.searchParams.get('sid') || '';
    const s = sessions.get(sid);
    if (!s) return sendJSON(res, 404, { error: 'session not found' });
    cleanupSession(sid);   // kill ffmpeg + 延迟删除目录
    sendJSON(res, 200, { ok: true });
    return;
  }

  /* ---- API：跳转未转码区域（复用同一会话/缓存目录，从指定秒重新转码） ---- */
  if (p === '/api/seek') {
    const sid = u.searchParams.get('sid') || '';
    const to = parseFloat(u.searchParams.get('to'));
    if (!sessions.has(sid) || !isFinite(to) || to < 0) {
      return sendJSON(res, 400, { error: 'invalid seek params' });
    }
    const s = seekTranscode(sid, to);
    if (!s) return sendJSON(res, 404, { error: 'session not found' });
    sendJSON(res, 200, {
      ok: true,
      sid: s.sid,
      playlist: '/hls/' + s.sid + '/index.m3u8',
      startSec: s.startSec
    });
    return;
  }

  /* ---- API：转码（立即返回，后台 ffmpeg 实时转码） ---- */
  if (p === '/api/transcode') {
    const url = u.searchParams.get('url') || '';
    if (!safeURL(url)) return sendJSON(res, 400, { error: 'invalid url' });
    // 转码并发上限：防止同时启动过多 ffmpeg 进程打爆 CPU/内存
    if (activeTranscodeCount() >= CFG.maxConcurrent) {
      return sendJSON(res, 503, { error: '转码服务繁忙，请稍后再试（同时转码已达上限 ' + CFG.maxConcurrent + ' 路）' });
    }
    // start 参数：从指定秒数开始转码（拖动到未转码区域时使用）
    const startSec = Math.max(0, parseFloat(u.searchParams.get('start')) || 0);
    const session = startTranscode(url, startSec);
    sendJSON(res, 200, {
      sid: session.sid,
      playlist: '/hls/' + session.sid + '/index.m3u8',
      name: baseName(url),
      startSec: session.startSec
    });
    return;
  }

  /* ---- 转码产物：m3u8 / ts ---- */
  const hlsMatch = p.match(/^\/hls\/([a-f0-9]+)\/(.+)$/);
  if (hlsMatch) {
    handleStreamFile(req, res, hlsMatch[1], hlsMatch[2]);
    return;
  }

  /* ---- API：转码会话状态（总时长 / 是否就绪 / 错误） ---- */
  if (p === '/api/status') {
    const sid = u.searchParams.get('sid') || '';
    const s = sessions.get(sid);
    if (!s) return sendJSON(res, 404, { error: 'session not found' });
    // 服务端限流：同一 sid 每 1 秒最多完整响应一次，其余返回 429。
    // 防止页面残留的旧轮询定时器（幽灵请求）高频轰炸服务器。
    const now = Date.now();
    if (s.lastStatusAt && now - s.lastStatusAt < 1000) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'throttled' }));
    }
    s.lastStatusAt = now;
    const ready = fs.existsSync(path.join(s.dir, 'index.m3u8'));
    sendJSON(res, 200, {
      sid: s.sid,
      startSec: s.startSec || 0,     // 本会话转码的起始秒（用于前端时间映射）
      name: s.name,
      duration: s.duration,           // 秒；ffmpeg 解析出后即返回
      transcoded: s.transcoded || 0,  // 秒；已实时转码到的时间点
      ready: ready,                   // 首片是否已产出
      closed: !!s.closed,
      error: s.error || null,
      segCount: countSegments(s.dir)
    });
    return;
  }

  /* ---- API：健康检查 ---- */
  if (p === '/api/health') {
    sendJSON(res, 200, {
      ok: true,
      sessions: sessions.size,
      ffmpeg: true
    });
    return;
  }

  /* ---- 静态资源 ---- */
  let filePath = path.join(PUBLIC, p === '/' ? 'index.html' : p);
  if (!filePath.startsWith(PUBLIC)) return sendText(res, 403, 'forbidden');
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) return sendText(res, 404, 'not found');
    const ext = path.extname(filePath).toLowerCase();
    const map = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon'
    };
    res.writeHead(200, {
      'Content-Type': map[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log('==============================================');
  console.log('  云点播服务器已启动');
  console.log('  访问地址: http://localhost:' + PORT);
  console.log('  ffmpeg 转码就绪，支持 avi/mkv/rmvb/wmv 等格式');
  console.log('  按 Ctrl+C 停止服务');
  console.log('==============================================');
});
