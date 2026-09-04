# 云点播 · 任意格式远程视频播放服务

输入远程视频 URL 即可播放，支持任意格式（含浏览器原生不支持的 AVI / MKV / RMVB / WMV / FLV 等），
实现秒开与进度自由拖拽。

## 运行

```bash
cd cloud-vod-player
node server.js
```

然后浏览器打开：**http://localhost:8787**

> 需要本机已安装 `ffmpeg`（用于实时转码为 HLS）。检查：`ffmpeg -version`
> - **Mac**：`brew install ffmpeg`
> - **Windows**：从 [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) 下载 `release essentials`，解压后将 `bin` 目录加入系统 PATH；或不配 PATH，直接在 `config.json` 里填 `ffmpegPath` 的完整路径（见下方配置表）。

## 配置

所有可调参数集中在 **`config.json`**（已提供默认配置；模板见 **`config.example.json`**，内含每个配置项的中文说明）。

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `port` | `8787` | 服务监听端口 |
| `ua` | Chrome UA | 抓取源站视频的 User-Agent，部分源站校验 UA |
| `hlsTime` | `6` | 转码 HLS 分片秒数（6 推荐；越小拖动越精确但请求越频繁） |
| `audioBitrateK` | `160` | 音频转码码率 kbps |
| `x264Preset` | `ultrafast` | x264 转码预设：`ultrafast`=最快（推荐）；`veryfast`=快但体积小；`slow`=最慢但体积最小画质好 |
| `x264Crf` | `23` | x264 质量系数（18-28，越小画质越好体积越大） |
| `maxCacheMB` | `2048` | tmp 转码缓存总配额 MB，超限自动清理最不活跃会话 |
| `quotaScanSec` | `60` | 缓存配额扫描间隔秒 |
| `maxConcurrent` | `3` | 同时转码的 ffmpeg 进程上限（预留配置项） |
| `ffmpegPath` | `ffmpeg` | ffmpeg 可执行文件路径。Mac/Linux 保持默认；Windows 可填完整路径如 `C:\ffmpeg\bin\ffmpeg.exe` |
| `ffprobePath` | `ffprobe` | ffprobe 可执行文件路径（预留，当前版本通过解析 ffmpeg stderr 获取时长） |

修改 `config.json` 后**重启**生效：`node server.js`。

## 工作原理

### 会话式 HLS 转码架构

所有视频（无论格式）统一通过 ffmpeg 实时转码为 HLS 流（m3u8 + ts 分片），前端使用 hls.js 播放。

**核心设计：每个转码起点一个独立会话目录**

```
tmp/{videoHash}/
├── info.json                    # 视频时长等元信息
└── sessions/
    ├── s_0/                     # 从0秒开始的转码会话
    │   ├── playlist.m3u8        # ffmpeg 自己生成的标准 HLS 清单
    │   ├── seg_000.ts           # 第1个分片（0-6秒）
    │   ├── seg_001.ts           # 第2个分片（6-12秒）
    │   └── ...
    └── s_60/                    # 从60秒开始的转码会话
        ├── playlist.m3u8
        ├── seg_000.ts           # 第1个分片（60-66秒）
        └── ...
```

**关键特性：**

1. **ffmpeg 自己生成 m3u8**：后端不做动态 m3u8 拼接，只做静态文件服务，简单可靠
2. **秒开**：ffmpeg 启动后第一个分片（6秒）很快生成，前端 hls.js 自动重试等待
3. **任意位置可拖拽**：
   - 拖到**已缓存区域** → 复用已有会话，hls.js 原生 seek，秒开
   - 拖到**未缓存区域** → 停止旧 ffmpeg，从目标位置创建新会话转码
4. **一个视频一个 ffmpeg**：拖动到新位置时旧 ffmpeg 立即停止，不会后台继续缓存浪费资源
5. **总时长即时显示**：ffmpeg 打开输入时即解析 Duration，通过 `/api/status` 提供给前端

### 前台路径 → 后台物理路径映射

| 前台请求路径 | 后台物理路径 |
|---|---|
| `/hls/{hash}/sessions/s_0/playlist.m3u8` | `项目目录/tmp/{hash}/sessions/s_0/playlist.m3u8` |
| `/hls/{hash}/sessions/s_0/seg_000.ts` | `项目目录/tmp/{hash}/sessions/s_0/seg_000.ts` |

即 `/hls/` 前缀直接映射到 `项目根目录/tmp/`。

## 嵌入第三方网页（JS SDK）

提供 `embed.js`，可将播放器以 Shadow DOM 组件形式嵌入任意网页，样式与独立播放器完全一致（左上角转码提醒、自定义控制条、进度拖拽全部保留），与宿主页面样式完全隔离。

### 快速开始（声明式）

```html
<!-- 1. 放一个容器 -->
<div style="width:100%;aspect-ratio:16/9;"
     data-cloud-vod
     data-url="https://example.com/video.avi"></div>

<!-- 2. 引入 SDK（自动扫描 data-cloud-vod 元素并初始化） -->
<script src="http://你的服务器:8787/embed.js"></script>
```

### JS API 用法

```html
<div id="player" style="width:100%;aspect-ratio:16/9;"></div>
<script src="http://你的服务器:8787/embed.js"></script>
<script>
  var p = new CloudVodPlayer('#player', {
    url: 'https://example.com/video.avi',
    autoplay: false,
    muted: false,
    theme: { primary: '#f2b24c', radius: '16px' }  // 可选
  });

  // 事件监听
  p.on('ready', function() { console.log('时长:', p.getDuration()); });
  p.on('timeupdate', function(t) { /* 当前播放位置(秒) */ });
  p.on('ended', function() { console.log('播完了'); });
  p.on('error', function(e) { console.log(e.title, e.text); });

  // 播放控制
  p.play();
  p.pause();
  p.seek(120);        // 跳到 2 分钟
  p.load('新视频地址');
  p.destroy();
</script>
```

### 配置选项

| 选项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `url` | string | `''` | 视频地址 |
| `server` | string | 自动推断 | 云点播服务器地址（默认从 embed.js 的 script src 推断） |
| `autoplay` | boolean | `false` | 自动播放（浏览器策略下需配合 muted） |
| `muted` | boolean | `false` | 静音 |
| `lazy` | boolean | `true` | 懒加载（滚到可视区附近再初始化） |
| `theme.primary` | string | `#f2b24c` | 主题色（进度条、按钮、转码标签） |
| `theme.radius` | string | `16px` | 播放器圆角 |

### 方法

| 方法 | 说明 |
|---|---|
| `load(url)` | 加载新视频 |
| `play()` | 播放 |
| `pause()` | 暂停 |
| `seek(seconds)` | 跳转到指定秒数 |
| `getCurrentTime()` | 获取当前播放位置（秒） |
| `getDuration()` | 获取总时长（秒） |
| `on(event, cb)` | 监听事件 |
| `off(event, cb)` | 取消监听 |
| `destroy()` | 销毁播放器，释放资源 |

### 事件

| 事件 | 回调参数 | 说明 |
|---|---|---|
| `ready` | — | 视频元数据加载完成 |
| `play` | — | 开始播放 |
| `pause` | — | 暂停 |
| `timeupdate` | `currentTime` | 播放位置变化（秒） |
| `durationchange` | `duration` | 总时长变化（秒） |
| `ended` | — | 播放结束 |
| `error` | `{title, text}` | 播放错误 |
| `destroy` | — | 播放器销毁 |

### 声明式 data 属性

| 属性 | 说明 |
|---|---|
| `data-cloud-vod` | 标记为自动初始化的播放器容器 |
| `data-url` | 视频地址 |
| `data-autoplay="true"` | 自动播放 |
| `data-muted="true"` | 静音 |
| `data-theme-primary="#4cc38a"` | 主题色 |
| `data-theme-radius="20px"` | 圆角 |

### 注意事项

- **HTTPS**：若宿主页面是 HTTPS，云点播服务器也需 HTTPS（可用 Nginx 反代加证书），否则浏览器拦截混合内容。
- **自动播放**：浏览器禁止有声自动播放，`autoplay: true` 时建议同时设 `muted: true`，用户点击后再开声。
- **样式隔离**：播放器渲染在 Shadow DOM 内，宿主页面的 CSS 不会影响播放器，播放器的 CSS 也不会污染宿主页面。
- **容器自适应**：播放器容器会自动适配视频原始宽高比，无需手动设置 aspect-ratio。

## API

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/play?url=...` | GET/POST | 启动播放（从0秒开始转码），返回 `{ok, hash, playlist, startSec, reused, duration, name}` |
| `/api/seek?url=...&time=秒` | GET/POST | 跳转到指定时间（已缓存则复用旧会话秒开，未缓存则创建新会话转码），返回同上 |
| `/api/status?url=...` | GET | 查询转码状态，返回 `{ok, duration, activeSession, isTranscoding, activeTranscodedSec, sessionCount}` |
| `/api/stop?url=...` | GET | 停止当前视频的转码 |
| `/hls/{hash}/sessions/s_{startSec}/playlist.m3u8` | GET | HLS 播放清单（Cache-Control: no-store，ffmpeg 转码中会动态更新） |
| `/hls/{hash}/sessions/s_{startSec}/seg_XXX.ts` | GET | HLS 分片（Cache-Control: public, max-age=3600，分片不可变可缓存） |

## 目录结构

```
cloud-vod-player/
├── server.js             # Node 服务器（ffmpeg 实时转码 + HLS 静态文件服务 + CORS）
├── package.json
├── config.json           # 实际配置（已 gitignore，从 config.example.json 复制）
├── config.example.json   # 配置模板（含每项中文说明）
├── README.md
├── public/
│   ├── index.html        # 独立播放器页面
│   ├── embed.js          # JS SDK（Shadow DOM 嵌入组件，供第三方网页引用）
│   └── hls.min.js        # hls.js 库
└── tmp/                  # 转码缓存（自动配额管理）
    └── {hash}/
        ├── info.json
        └── sessions/
            ├── s_0/
            │   ├── playlist.m3u8
            │   └── seg_*.ts
            └── s_60/
                ├── playlist.m3u8
                └── seg_*.ts
```

## 注意

- **所有格式统一转码**：无论 MP4 / AVI / MKV / FLV，都通过 ffmpeg 转码为 HLS 播放，保证格式兼容性和拖拽一致性。
- **转码会占用 CPU**，视视频分辨率与源站带宽而定；**源站下载慢时首片产出需要数秒到十余秒**，属正常现象（页面会持续等待，hls.js 自动重试）。
- **转码期间的 m3u8 无 `#EXT-X-ENDLIST`**：ffmpeg 边转边写 m3u8，hls.js 按直播流机制定期刷新清单以发现新分片；转码完成后清单写入 `#EXT-X-ENDLIST`，刷新自动停止。
- **拖动到已缓存区域秒开**：已转码的会话目录保留，后续拖回相同位置直接复用，无需重新转码。
- **拖动到未缓存区域创建新会话**：旧 ffmpeg 立即停止，从目标位置启动新 ffmpeg 转码，不会后台继续缓存浪费资源。
- **tmp 缓存空间管理（防无限膨胀）**：tmp 转码缓存总量默认上限 **2GB**（`maxCacheMB` 配置）。每 60 秒自动扫描，超限时从最不活跃的会话开始清理。单个约 18 分钟视频转码缓存约 59MB，2GB 配额可容纳约 30 个完整视频。
- **ts 分片转码后不可变**，服务器返回 `Cache-Control: public, max-age=3600`，浏览器不再重复下载已看分片；m3u8 返回 `Cache-Control: no-store`，确保转码中能拿到最新清单。
- **源站需允许直接访问**（反爬严格的站可能被拒）。
- **端口默认 8787**，修改 `config.json` 后重启生效。
