# video-storyboard-mcp

[English](README.md)

基于开源项目 [SAOS-3624/dsh-video-storyboard](https://github.com/SAOS-3624/dsh-video-storyboard)（`v0.7.6`，Apache-2.0）重构的跨平台 **MCP Server**、**CLI 工具**与 **Antigravity 插件**。零第三方 npm 依赖，支持**普通视频省流总结（`preset: "summary"`）**与**长时间网课零遗漏笔记/PDF（`preset: "lecture"` + `video_transcript`）**双档模式，可直接接入 **Antigravity、Claude Code、Cursor、Gemini CLI、Codex**。

## 核心特性

- **双档模式分流（`summary` vs `lecture`）**：默认 `summary` 档保持旧模式极致省 token；网课/笔记/PDF 场景传 `preset: "lecture"` 自动启用 `detail: "high"` + `ocr: true` + `720p`（看清板书/PPT/代码）。
- **新增 `video_transcript`（零截断完整逐字稿）**：`0` 图片 token、不解码画面与切点、突破分镜单格 `60/120/400` 字截断；有站点 CC 字幕时无需下载 2 小时视频本体，超过 30 分钟默认按 `1200` 秒自动分页，也可 `full: true` + `saveFile: true` 落盘完整 `.md`。
- **变档场景分镜（`1/1`…`1/8`）+ DP 按行打包**：按镜头切点密度自适应分配格子尺寸（长镜头大格、快剪小格），裁掉黑边留白，默认单图仅约 `222` token。
- **底部音频包络 + 多源台词对齐**：自动绘制声压波形条，按优先级读取站点 CC 字幕、内嵌字幕轨、本地/云端 ASR，并支持 `detail: "high"` 局部 RapidOCR 硬字幕核对。
- **内置一键离线 ASR（`sherpa-onnx` + 自动启停托管）**：自带纯标准库服务 `server/asr_server.py` 与安装脚本 `setup-asr`，支持多语种 **SenseVoice**（中/英/日/韩/粤）与 **Paraformer** + **Silero VAD** 断句；按需拉起、闲置 `5` 秒自动 `/shutdown` 释放内存，且与分镜共享绝对时间缓存。
- **`video_clip` 与 `video_cache_clean`**：支持裁切短片段 `.mp4`/`.mp3` 供多模态客户端原生听音看动效，并在看完后一键清掉视频缓存、导出逐字稿与预览图。
- **B 站代理分流与 403 防护**：自动对 B 站域名及 CDN 注入 `NO_PROXY`、首轮附加 `Referer: https://www.bilibili.com/` 与浏览器 UA，遇到 `403/412/429/567` 时自动回退 `--proxy ""` 与 `--no-continue` 重试；Windows 下自动解析 `PATH` 中的 `ffmpeg`/`ffprobe` 绝对路径传给 `yt-dlp`。

## 9 个工具清单（MCP & CLI 通用）

| 工具名 | 用途 | 图片 Token 消耗 |
|---|---|---|
| `video_probe` | 只读容器/链接元数据（时长、分辨率、音轨/字幕状态），不下载 | `0` |
| `video_transcript` | 提取无截断完整带时间码/分段逐字稿（支持 20 分钟自动分页与 `.md` 落盘） | `0` |
| `video_storyboard` | 生成变档 DP 分镜图 + 对齐台词清单（支持 `preset: "summary" \| "lecture"`） | 约 `222` / 张 |
| `video_zoom` | 对指定 `cellId` 或 `[from, to]` 时间段高清放大重看 | 约 `222` |
| `video_locate` | 按台词关键词模糊检索出现时间码 | `0` |
| `video_subtitles` | 截取画面硬字幕带并按时间顺序纵向拼成一张长图 | 约 `222` |
| `video_help` | 按需输出参数、策略、`tierMap` 与计费说明手册 | `0` |
| `video_clip` | 裁切导出最长 90 秒的 `.mp4` / `.mp3` 片段供原生听音/看连续动作 | `0` |
| `video_cache_clean` | 清理下载的视频缓存、导出的逐字稿、片段及临时预览图 | `0` |

## 双档模式：一般总结 vs 两小时网课做笔记 / PDF

- **一般视频省流总结（`preset: "summary"`，默认）**：沿用旧版紧凑分镜与 `detail: "med"`，不额外拉全片逐字稿，最大程度省 token。
- **长时间网课 / 电子笔记 / PDF 生成（`preset: "lecture"`，全信息无遗漏）**：
  1. 先跑 `video_probe` 看时长和字幕轨状态（`0` token）。
  2. 用 `video_transcript`（超 30 分钟自动按 20 分钟分页，或 `full: true` + `saveFile: true` 导出 `.md`）无截断拿全老师全部口述内容。
  3. 用 `video_storyboard` 开启 `preset: "lecture"` 按 10 分钟窗口（`from` + `segment: 600`）抓 PPT 翻页与板书位置（自动 720p + `detail: "high"` + OCR，直接命中已缓存逐字稿不重复转写）。
  4. 遇到公式、代码、图表格子再用 `video_zoom` 高清核对，整理好笔记或 PDF 后运行 `video_cache_clean` 清缓存。

## 环境要求

- **Node.js `>= 20`**
- **`ffmpeg` + `ffprobe`**（Windows：`winget install Gyan.FFmpeg`，macOS：`brew install ffmpeg`）
- **`yt-dlp`**（可选，解析 B 站 / YouTube 等链接时需要：`pip install --user -U yt-dlp`）
- **Python `>= 3.9`**（可选，运行内置本地离线 ASR 或 `rapidocr` 时使用）

## 三步快速上手

### 1. 安装插件或导出 MCP 配置

```bash
# 安装为 Antigravity 全局插件（~/.gemini/config/plugins/video-storyboard/）
node scripts/install.mjs --antigravity-global

# 或安装到指定工作区（<workspace>/.agents/plugins/video-storyboard/）
node scripts/install.mjs --antigravity-workspace /path/to/workspace

# 或直接打印适配 Claude Code / Cursor / Gemini CLI / Codex 的 MCP JSON 配置
node scripts/install.mjs --print-mcp
```

### 2. 运行环境自检

```bash
node server/cli.mjs doctor
```

### 3. （可选）一键启用内置离线语音识别（`sherpa-onnx`）

默认不装 ASR 也能正常出分镜、读平台字幕或拼硬字幕图。若希望离线听清无字幕视频的人声台词，可一键安装内置的 **SenseVoice int8 + Silero VAD**（约需下载 `156 MB` 模型权重到本地 `.asr-runtime/`）：

```bash
# 先预览下载清单与配置，不实际下载
node server/cli.mjs setup-asr --dry-run

# 实际创建独立 .venv 并下载模型（中国大陆用户可加 --mirror hf）
node server/cli.mjs setup-asr

# 查看当前生效的 ASR 配置状态
node server/cli.mjs asr-status
```

> 优先级遵循「`DSH_ASR_*` 环境变量 > `~/.dsh/asr.json` > 插件内置 `DSH_ASR_FALLBACK_CONFIG`」，不会覆盖你原有的 DSH 配置。

## CLI 常用命令

```bash
node server/cli.mjs probe "https://b23.tv/..." --allow-anonymous
node server/cli.mjs transcript "https://b23.tv/..." --allow-anonymous --save-file
node server/cli.mjs storyboard "/path/to/video.mp4" --preset summary
node server/cli.mjs storyboard "/path/to/lecture.mp4" --preset lecture --from 0 --segment 600
node server/cli.mjs zoom "/path/to/video.mp4" --cell 2
node server/cli.mjs locate "/path/to/video.mp4" "某句台词"
node server/cli.mjs subtitles "/path/to/video.mp4" --max-strips 12
node server/cli.mjs clip "/path/to/video.mp4" --cell 2 --audio-only
node server/cli.mjs clean --all --include-scan-cache
```

## 常见问题（遇到 `HTTP 403 Forbidden` 怎么办）

1. **不要用通用下载器裸拉音视频直链**：如果模型/客户端提取了 B 站直链再用 `curl` 或内置 HTTP 下载器去拉 `<BV>-audio.m4a`，由于缺少 `Referer: https://www.bilibili.com/`、浏览器 UA 或解析与下载出口 IP 不一致，B 站 CDN 会直接拒收并返回 `403 (0B)`。请始终让 AI 直接调用本插件的 `video_transcript` / `video_storyboard` / `video_clip`。
2. **更新 `yt-dlp` 到最新版**：B 站和 YouTube 会定期调整风控签名，遇到 403 先运行 `pip install --user -U yt-dlp` 升级下载器。
3. **代理分流与自动直连（默认开启）**：本插件已默认对 B 站域名与 CDN（`.bilibili.com`、`.b23.tv`、`.bilivideo.*`、`.acgvideo.com`、`.hdslb.com`、`.szbdyd.com`）注入 `NO_PROXY`，并在遇到 `403/412/429/567` 时自动回退 `--proxy ""` 直连重拉；若刻意需要走代理访问 B 站，可设环境变量 `DSH_VIDEO_BILIBILI_PROXY=keep`。
4. **配置登录态 `cookies.txt`**：会员、充电专属或被风控限制的稿件需从浏览器导出 Netscape 格式 `cookies.txt`（切勿提交到仓库），在 `~/.dsh/video.json` 中写入 `{"cookies": "/path/to/cookies.txt"}`。

## 运行测试

```bash
npm test
```

内置离线测试（无需下载模型权重）会验证：MCP stdio JSON-RPC 9 工具注册与调用（含 `summary`/`lecture` 分档与 `video_transcript`）、`setup-asr --dry-run`、`scripts/install.mjs --print-mcp`、`HTTP 403` 防护与代理回退，以及拉起 `asr_server.py --mock` 完成真实音频转写对齐与空闲自动关闭的完整生命周期闭环。

## 开源协议与致谢

本项目采用 **Apache-2.0** 协议发布，核心分镜与时间轴引擎源自并内嵌 [SAOS-3624/dsh-video-storyboard](https://github.com/SAOS-3624/dsh-video-storyboard)（`v0.7.6`）。完整版权、原项目免责声明及修改清单见 [LICENSE](LICENSE)、[NOTICE](NOTICE) 与 [CREDITS.md](vendor/dsh-video-storyboard/CREDITS.md)。
