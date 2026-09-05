/* ============================================================
 * 云点播服务器（会话式 HLS 转码架构）
 *
 * 核心设计：
 *   1. 每次播放/seek 创建一个"转码会话"，输出到独立目录
 *   2. ffmpeg 自己生成 m3u8 和分片，后端不做动态 m3u8
 *   3. 前端直接播放 ffmpeg 生成的 m3u8
 *   4. seek 到未缓存区域时，创建新会话
 *   5. seek 到已缓存区域时，复用已有会话
 *
 * 目录结构：
 *   tmp/{videoHash}/
 *     sessions/
 *       s_{startSec}/   从 startSec 秒开始的转码会话
 *         playlist.m3u8
 *         seg_000.ts
 *         seg_001.ts
 *         ...
 *     info.json         视频时长等元信息
 * ============================================================ */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const url = require('url');

/* ================= 配置 ================= */
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const TMP = path.join(ROOT, 'tmp');

const DEFAULTS = {
  port: 8787,
  basePath: '/vod',
  hlsTime: 6,
  audioBitrateK: 160,
  x264Preset: 'ultrafast',
  x264Crf: 23,
  maxCacheMB: 2048,
  quotaScanSec: 60,
  maxConcurrent: 3,
  ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  ffmpegPath: 'ffmpeg',
  ffprobePath: 'ffprobe'
};

let CFG = {};
try { CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); }
catch (e) { CFG = {}; }
CFG = Object.keys(DEFAULTS).reduce((o, k) => { o[k] = CFG[k] !== undefined ? CFG[k] : DEFAULTS[k]; return o; }, {});

const PORT = CFG.port;
const UA = CFG.ua;
const FFMPEG_PATH = CFG.ffmpegPath || 'ffmpeg';
const HLS_TIME = CFG.hlsTime;
const MAX_CACHE_BYTES = CFG.maxCacheMB * 1024 * 1024;
// 规范化 basePath：确保以 / 开头，不以 / 结尾（空字符串表示无前缀）
let BASE_PATH = (CFG.basePath || '').replace(/\/+$/, '');
if (BASE_PATH && !BASE_PATH.startsWith('/')) BASE_PATH = '/' + BASE_PATH;

if (!fs.existsSync(PUBLIC)) fs.mkdirSync(PUBLIC, { recursive: true });
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

/* ================= 视频状态管理 ================= */
/*
 * videoStates: hash -> {
 *   url, dir, duration,
 *   sessions: Map<startSec, { dir, proc, transcodedSec, lastAccess }>
 *   activeSession: startSec | null  // 当前正在转码的会话
 * }
 */
const videoStates = new Map();

function videoHash(url) {
  return crypto.createHash('md5').update(url).digest('hex').slice(0, 12);
}

function getOrCreateState(vurl) {
  const hash = videoHash(vurl);
  let st = videoStates.get(hash);
  if (!st) {
    const dir = path.join(TMP, hash);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
    st = {
      hash, url: vurl, dir,
      duration: null,
      sessions: new Map(),
      activeSession: null
    };
    // 恢复 info.json
    try {
      const info = JSON.parse(fs.readFileSync(path.join(dir, 'info.json'), 'utf8'));
      if (info.duration) st.duration = info.duration;
    } catch (e) {}
    videoStates.set(hash, st);
  }
  return st;
}

function saveInfo(st) {
  try {
    fs.writeFileSync(path.join(st.dir, 'info.json'), JSON.stringify({ duration: st.duration, url: st.url }));
  } catch (e) {}
}

/* ================= 转码会话 ================= */

function sessionDir(st, startSec) {
  return path.join(st.dir, 'sessions', 's_' + startSec);
}

function sessionPlaylistUrl(st, startSec) {
  // 返回相对路径（不带 basePath），由前端 _api 方法统一加 basePath
  return '/hls/' + st.hash + '/sessions/s_' + startSec + '/playlist.m3u8';
}

/* 检查会话是否已有足够的连续分片（至少1个完整分片） */
function sessionHasChunks(st, startSec) {
  const dir = sessionDir(st, startSec);
  try {
    const files = fs.readdirSync(dir);
    return files.some(f => /^seg_\d+\.ts$/.test(f) && fs.statSync(path.join(dir, f)).size > 1024);
  } catch (e) {
    return false;
  }
}

/* 获取会话已转码的秒数（基于分片数量估算） */
function sessionTranscodedSec(st, startSec) {
  const dir = sessionDir(st, startSec);
  try {
    const files = fs.readdirSync(dir).filter(f => /^seg_\d+\.ts$/.test(f));
    return files.length * HLS_TIME;
  } catch (e) {
    return 0;
  }
}

/* 跨平台终止子进程
 * Windows: 直接调用 TerminateProcess 强制终止
 * Unix: 先发送 SIGTERM 优雅退出，2秒后未退出再 SIGKILL 强制终止
 */
function killProcess(proc) {
  if (!proc || proc.killed) return;
  try {
    if (process.platform === 'win32') {
      // Windows 下 kill() 不传信号默认使用 TerminateProcess
      proc.kill();
    } else {
      // Unix 下先尝试优雅退出
      proc.kill('SIGTERM');
      // 2秒后如果进程还在，强制终止
      setTimeout(() => {
        try { if (!proc.killed) proc.kill('SIGKILL'); } catch (e) {}
      }, 2000);
    }
  } catch (e) {}
}

/* 停止当前活跃的 ffmpeg */
function stopActiveFFmpeg(st) {
  if (st.activeSession !== null) {
    const sess = st.sessions.get(st.activeSession);
    if (sess && sess.proc) {
      killProcess(sess.proc);
      sess.proc = null;
    }
  }
  st.activeSession = null;
}

/* 启动转码会话（异步，等待第一个 playlist.m3u8 生成后返回） */
async function startSession(st, startSec) {
  startSec = Math.max(0, Math.floor(startSec));

  // 如果 duration 已知，限制 startSec 不超过视频末尾
  if (st.duration !== null && startSec >= st.duration - 1) {
    startSec = Math.max(0, Math.floor((st.duration - HLS_TIME) / HLS_TIME) * HLS_TIME);
  }

  // 停止当前活跃的 ffmpeg
  stopActiveFFmpeg(st);

  // 如果会话已存在且有分片，直接复用（不启动新 ffmpeg）
  if (sessionHasChunks(st, startSec)) {
    const existing = st.sessions.get(startSec);
    if (existing) {
      existing.lastAccess = Date.now();
    } else {
      st.sessions.set(startSec, {
        dir: sessionDir(st, startSec),
        proc: null,
        transcodedSec: sessionTranscodedSec(st, startSec),
        lastAccess: Date.now()
      });
    }
    st.activeSession = startSec;
    return { startSec, reused: true, playlist: sessionPlaylistUrl(st, startSec) };
  }

  // 创建会话目录
  const dir = sessionDir(st, startSec);
  fs.mkdirSync(dir, { recursive: true });

  // 构建 ffmpeg 参数
  const ext = (st.url.split('?')[0].split('.').pop() || '').toLowerCase();
  const needOutputSeek = ['avi', 'flv', 'wmv', 'rmvb', 'rm', 'mpg', 'mpeg'].includes(ext);

  const args = ['-y'];
  // headers
  args.push('-headers', 'User-Agent: ' + UA + '\r\nReferer: ' + new URL(st.url).origin + '\r\n');
  // 分析时长（非 output-seek 格式）
  if (!needOutputSeek) {
    args.push('-analyzeduration', '5000000', '-probesize', '5000000');
  }
  args.push('-fflags', '+genpts');

  // seek 参数位置
  if (startSec > 0 && needOutputSeek) {
    args.push('-i', st.url);
    args.push('-ss', String(startSec));
  } else {
    if (startSec > 0) args.push('-ss', String(startSec));
    args.push('-i', st.url);
  }

  // 视频编码
  args.push('-c:v', 'libx264', '-preset', CFG.x264Preset, '-crf', String(CFG.x264Crf));
  args.push('-g', String(HLS_TIME * 30));
  args.push('-force_key_frames', 'expr:gte(t,n_forced*' + HLS_TIME + ')');
  // 音频编码
  args.push('-c:a', 'aac', '-b:a', CFG.audioBitrateK + 'k');
  // HLS 输出
  // 使用相对路径 + cwd 设置工作目录，确保 playlist.m3u8 中引用的 ts 分片
  // 是相对路径（如 seg_000.ts），避免 Windows 下反斜杠路径导致前端无法加载
  args.push('-f', 'hls');
  args.push('-hls_time', String(HLS_TIME));
  args.push('-hls_list_size', '0');
  args.push('-hls_flags', 'independent_segments');
  args.push('-hls_segment_filename', 'seg_%03d.ts');
  args.push('playlist.m3u8');

  console.log('[ffmpeg] 启动会话 s_' + startSec + ', args:', args.join(' ').substring(0, 200) + '...');

  const proc = spawn(FFMPEG_PATH, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    cwd: dir,  // 设置工作目录为会话目录，相对路径基于此目录
    windowsHide: true  // Windows 下隐藏 ffmpeg 控制台窗口
  });

  const sess = {
    dir, proc,
    transcodedSec: 0,
    lastAccess: Date.now()
  };
  st.sessions.set(startSec, sess);
  st.activeSession = startSec;

  // 解析 duration
  let errBuf = '';
  proc.stderr.on('data', (d) => {
    const s = d.toString();
    errBuf += s;
    if (st.duration === null) {
      const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s);
      if (m) {
        st.duration = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
        console.log('[ffmpeg] 解析到时长:', st.duration, '秒');
        saveInfo(st);
      }
    }
  });

  proc.on('close', (code) => {
    sess.proc = null;
    sess.transcodedSec = sessionTranscodedSec(st, startSec);
    console.log('[ffmpeg] 会话 s_' + startSec + ' 退出, code:', code, ', 已转码:', sess.transcodedSec, '秒');
    if (code !== 0 && sess.transcodedSec === 0) {
      // 转码失败且没有产出任何分片，打印 stderr 最后 500 字符用于排查
      const errTail = errBuf.slice(-500);
      console.log('[ffmpeg] 转码失败 stderr 末尾:', errTail);
    }
    if (st.activeSession === startSec) {
      st.activeSession = null;
    }
  });

  proc.on('error', (e) => {
    console.log('[ffmpeg] 启动失败:', e.message);
    sess.proc = null;
  });

  // 等待第一个 playlist.m3u8 生成（最多等 15 秒），避免前端请求 404
  const playlistPath = path.join(dir, 'playlist.m3u8');
  const waitStart = Date.now();
  let ready = false;
  while (Date.now() - waitStart < 15000) {
    if (fs.existsSync(playlistPath) && fs.statSync(playlistPath).size > 0) {
      ready = true;
      break;
    }
    // 如果 ffmpeg 已经退出且没生成 playlist，立即返回失败，不要等满 15 秒
    if (!sess.proc) {
      console.log('[ffmpeg] 会话 s_' + startSec + ' ffmpeg 已退出但未生成 playlist.m3u8，转码失败');
      break;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  if (ready) {
    console.log('[ffmpeg] 会话 s_' + startSec + ' playlist.m3u8 已就绪，耗时:', (Date.now() - waitStart) + 'ms');
  }

  return { startSec, reused: false, playlist: sessionPlaylistUrl(st, startSec), ready };
}

/* ================= 配额管理 ================= */

function dirSize(p) {
  let total = 0;
  try {
    const items = fs.readdirSync(p);
    for (const item of items) {
      const fp = path.join(p, item);
      try {
        const stat = fs.statSync(fp);
        if (stat.isDirectory()) total += dirSize(fp);
        else total += stat.size;
      } catch (e) {}
    }
  } catch (e) {}
  return total;
}

function quotaCheck() {
  const total = dirSize(TMP);
  if (total <= MAX_CACHE_BYTES) return;
  console.log('[quota] 缓存超限:', (total / 1024 / 1024).toFixed(1), 'MB >', CFG.maxCacheMB, 'MB, 开始清理');

  // 收集所有视频目录，按最后访问时间排序
  const videos = [];
  try {
    const items = fs.readdirSync(TMP);
    for (const item of items) {
      const fp = path.join(TMP, item);
      try {
        const stat = fs.statSync(fp);
        if (stat.isDirectory()) {
          videos.push({ path: fp, mtime: stat.mtimeMs, size: dirSize(fp) });
        }
      } catch (e) {}
    }
  } catch (e) {}

  videos.sort((a, b) => a.mtime - b.mtime);

  let freed = 0;
  for (const v of videos) {
    if (dirSize(TMP) - freed <= MAX_CACHE_BYTES * 0.8) break;
    try {
      fs.rmSync(v.path, { recursive: true, force: true });
      freed += v.size;
      console.log('[quota] 已清理:', path.basename(v.path), (v.size / 1024 / 1024).toFixed(1), 'MB');
      // 从内存中移除
      for (const [hash, st] of videoStates) {
        if (st.dir === v.path) {
          stopActiveFFmpeg(st);
          videoStates.delete(hash);
          break;
        }
      }
    } catch (e) {}
  }
}

setInterval(quotaCheck, CFG.quotaScanSec * 1000);

/* ================= 小工具 ================= */

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

function sendText(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(text);
}

function safeURL(u) {
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

function baseName(u) {
  try {
    const p = new URL(u).pathname;
    return decodeURIComponent(p.substring(p.lastIndexOf('/') + 1)) || 'video';
  } catch (e) {
    return 'video';
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

/* ================= HTTP 服务器 ================= */

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // basePath 前缀处理：去掉前缀得到内部路径 rp
  let rp = p;
  if (BASE_PATH) {
    if (p === '/' || p === '') {
      // 访问根路径，重定向到 basePath
      res.writeHead(302, { 'Location': BASE_PATH + '/' });
      res.end();
      return;
    } else if (p === BASE_PATH || p === BASE_PATH + '/') {
      // 访问 basePath 根路径，映射到 index.html
      rp = '/';
    } else if (p.startsWith(BASE_PATH + '/')) {
      rp = p.slice(BASE_PATH.length);
    } else {
      // 不在 basePath 下，返回 404
      sendText(res, 404, 'not found');
      return;
    }
  }

  if (rp.startsWith('/api/') || rp.startsWith('/hls/')) {
    console.log('[req]', new Date().toISOString().slice(11, 19), p + (u.search || ''));
  }

  /* ---- API: 播放（从0秒开始） ---- */
  if (rp === '/api/play' && (req.method === 'GET' || req.method === 'POST')) {
    const vurl = u.searchParams.get('url') || '';
    if (!safeURL(vurl)) return sendJSON(res, 400, { error: 'invalid url' });
    const st = getOrCreateState(vurl);
    const result = await startSession(st, 0);
    sendJSON(res, 200, {
      ok: true,
      hash: st.hash,
      playlist: result.playlist,
      startSec: result.startSec,
      reused: result.reused,
      ready: result.ready !== false,
      duration: st.duration,
      name: baseName(vurl)
    });
    return;
  }

  /* ---- API: seek（从指定时间开始） ---- */
  if (rp === '/api/seek' && (req.method === 'GET' || req.method === 'POST')) {
    const vurl = u.searchParams.get('url') || '';
    const time = parseFloat(u.searchParams.get('time') || '0');
    if (!safeURL(vurl) || !isFinite(time) || time < 0) return sendJSON(res, 400, { error: 'invalid params' });
    const st = getOrCreateState(vurl);
    const result = await startSession(st, time);
    sendJSON(res, 200, {
      ok: true,
      hash: st.hash,
      playlist: result.playlist,
      startSec: result.startSec,
      reused: result.reused,
      ready: result.ready !== false,
      duration: st.duration
    });
    return;
  }

  /* ---- API: 状态查询 ---- */
  if (rp === '/api/status') {
    const vurl = u.searchParams.get('url') || '';
    if (!safeURL(vurl)) return sendJSON(res, 400, { error: 'invalid url' });
    const st = getOrCreateState(vurl);
    const activeSess = st.activeSession !== null ? st.sessions.get(st.activeSession) : null;
    let activeTranscoded = 0;
    if (activeSess) {
      activeTranscoded = activeSess.proc ? sessionTranscodedSec(st, st.activeSession) : activeSess.transcodedSec;
    }
    sendJSON(res, 200, {
      ok: true,
      duration: st.duration,
      activeSession: st.activeSession,
      isTranscoding: activeSess && activeSess.proc !== null,
      activeTranscodedSec: activeTranscoded,
      sessionCount: st.sessions.size
    });
    return;
  }

  /* ---- API: 停止转码 ---- */
  if (rp === '/api/stop') {
    const vurl = u.searchParams.get('url') || '';
    if (!safeURL(vurl)) return sendJSON(res, 400, { error: 'invalid url' });
    const st = getOrCreateState(vurl);
    stopActiveFFmpeg(st);
    sendJSON(res, 200, { ok: true });
    return;
  }

  /* ---- HLS 静态文件服务 ---- */
  const hlsMatch = rp.match(/^\/hls\/([a-f0-9]+)\/(.+)$/);
  if (hlsMatch) {
    const hash = hlsMatch[1];
    const rel = hlsMatch[2];
    const st = videoStates.get(hash);
    if (!st) return sendText(res, 404, 'video not found');

    // 更新访问时间
    if (st.activeSession !== null) {
      const sess = st.sessions.get(st.activeSession);
      if (sess) sess.lastAccess = Date.now();
    }

    const file = path.join(st.dir, rel);
    if (!file.startsWith(st.dir)) return sendText(res, 403, 'forbidden');
    if (!fs.existsSync(file)) return sendText(res, 404, 'not found');

    const ext = path.extname(file).toLowerCase();
    const stat = fs.statSync(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': ext === '.m3u8' ? 'no-store' : 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*'
    });
    fs.createReadStream(file).pipe(res);
    return;
  }

  /* ---- 静态文件服务 ---- */
  let filePath = path.join(PUBLIC, rp === '/' ? 'index.html' : rp);
  if (!filePath.startsWith(PUBLIC)) return sendText(res, 403, 'forbidden');
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const stat = fs.statSync(filePath);
    // HTML 文件做模板替换，注入 basePath，实现一处配置全局生效
    if (ext === '.html') {
      let content = fs.readFileSync(filePath, 'utf8');
      content = content.replace(/\{\{basePath\}\}/g, BASE_PATH);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(content),
        'Cache-Control': 'no-cache'
      });
      res.end(content);
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': stat.size });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  sendText(res, 404, 'not found');
});

server.listen(PORT, () => {
  console.log('==============================================');
  console.log('  云点播服务器已启动（会话式 HLS 转码架构）');
  console.log('  访问地址: http://localhost:' + PORT + BASE_PATH + '/');
  console.log('  basePath: ' + (BASE_PATH || '(无前缀)'));
  console.log('  ffmpeg 转码就绪，' + HLS_TIME + '秒分片');
  console.log('  按 Ctrl+C 停止服务');
  console.log('==============================================');
});
