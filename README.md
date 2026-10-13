# Strata Console

> A Hana app to monitor, configure and control a local **Strata** inference service.

[English](#english) · [中文](#中文)

---

## English

### What it is

**Strata Console** is a Hana App that puts a single control surface on top of a
local [Strata](https://github.com/Niko1221/Strata) inference server. Running a
large model with Strata means keeping a process alive, watching memory and
VRAM, and occasionally restarting it after a config change — this app makes
that a couple of clicks instead of a terminal session.

The UI ships in **6 languages** (English, 中文, Français, Русский, 日本語,
한국어). It auto-detects the browser language and can be switched manually from
the header.

### Features

- **Status at a glance** — state light, model, uptime, port, address, API Key.
- **Start / stop** with a confirmation popover and a full-screen progress
  overlay while the engine loads or shuts down.
- **Local / LAN mode** switching (LAN requires a restart and asks first).
- **Version check + one-click update** — reads the latest release, then stops
  the service, pulls and rebuilds, and restarts it.
- **Resources** — VRAM and RAM bars.
- **Performance** — generation `tg`, prefill `pp`, expert-cache hit rate and
  KV hit rate.
- **Parameter editing** — context length, KV quantization, session cache,
  sampling parameters, max output and reasoning effort, with a pending-change
  diff and a "save & restart" action.
- **Logs** — tail of the Strata log.
- **First-run setup** — point at the Strata directory and a Python
  interpreter, then pick one of the discovered `strata-*.json` config files.
- **Auto-start** — optionally bring Strata up together with Hana.

### Requirements

| Item | Requirement |
|---|---|
| Hana | `1.1.0-beta` or newer (v2 App) |
| Platform | **Windows 10/11**, **Linux** — macOS is not supported by Strata |
| Strata | A deployed Strata checkout plus a Python environment |
| Update feature | `git` and a CUDA toolchain if you use the in-app updater |

The app itself talks to the local Strata API (`127.0.0.1` / `localhost`) and to
`api.github.com` for release checks.

### Install

**From the market** — once the app is listed, install it from Hana's
*Market → Installed* page and approve the review card.

**From a local directory** — copy this folder to
`<HANA_HOME>/apps/hanako-localstrata/`, then approve it from Hana's *Market →
Installed* page (App category, "waiting for approval" block). The folder name
must match the manifest `id`.

### Configuration

Configured in Hana's settings page (app **Local Strata**):

| Key | Default | Meaning |
|---|---|---|
| `strataDir` | — | Path to the Strata project; also set from the in-app setup form |
| `pythonPath` | — | Python interpreter; empty = auto-detect `python3` / `python.exe` |
| `configFile` | — | Auto-discovered `strata-*.json`; no need to type it |
| `port` | `0` | `0` = use the port from the selected config file |
| `autoStart` | `false` | Try to start Strata together with Hana |
| `refreshSec` | `5` | Status polling interval, in seconds |
| `apiKey` | — | Strata API key, if the service requires one |

### Tech notes

- **Windows** follows Strata's official `.bat` scripts; **Linux** is the
  primary tested platform. macOS short-circuits to an "unsupported" notice and
  hides every control.
- The **CUDA selection** for updates keys off whether the interpreter
  environment ships its own `nvcc` (conda with a toolkit) rather than guessing
  from `sys.prefix`.
- Technical terms that have no stable translation in local inference
  (`KV`, `prefill`, `token`, `temperature`, `top_p`, `tg` / `pp`, …) are kept
  verbatim in every language.

### Development

```bash
node <hana-app-creator>/scripts/validate_app.mjs --dir . --json
```

Requires a Hana install that provides `scripts/validate-app.mjs`
(`HANA_APP_TOOLS_ROOT` can point at the Hana Server directory).

### License

[MIT](./LICENSE)

---

## 中文

### 是什么

**Strata Console** 是一个 Hana App，为本地 [Strata](https://github.com/Niko1221/Strata)
推理服务提供一个统一的控制面板。用 Strata 跑大模型需要保持进程常驻、盯显存和内存，
改完配置还得手动重启——这个 App 把这些操作变成点几下按钮。

界面支持 **6 种语言**（中文 / English / Français / Русский / 日本語 / 한국어），
会按浏览器语言自动检测，也可以在顶部手动切换。

### 功能

- **状态一览** —— 状态灯、模型、运行时长、端口、地址、API Key。
- **启动 / 停止** —— 带二次确认浮层；加载/停机期间显示全屏进度遮罩。
- **本地 / 局域网模式切换** —— 局域网需要重启，切换前会先确认。
- **版本检查 + 一键更新** —— 读取最新版本，然后停服、拉取代码、编译引擎、重启。
- **资源占用** —— 显存与内存进度条。
- **性能** —— 生成 `tg`、预填 `pp`、专家缓存命中率、KV 命中率。
- **参数编辑** —— 上下文长度、KV 量化、会话缓存、采样参数、最大输出、思考档位，
  带待保存改动对比和「保存并重启」。
- **日志** —— Strata 日志尾部。
- **首次配置引导** —— 填写 Strata 目录与 Python 解释器，再选择自动发现的
  `strata-*.json` 配置文件。
- **随 Hana 启动** —— 可选是否随 Hana 一起拉起 Strata。

### 要求

| 项 | 要求 |
|---|---|
| Hana | `1.1.0-beta` 或更新（v2 App）|
| 平台 | **Windows 10/11**、**Linux**；macOS 不被 Strata 支持 |
| Strata | 已部署的 Strata 目录 + Python 环境 |
| 更新功能 | 使用内置更新时需要 `git` 与 CUDA 工具链 |

App 只访问本机 Strata API（`127.0.0.1` / `localhost`），以及用于版本检查的
`api.github.com`。

### 安装

**从市场安装** —— 上架后，在 Hana 的「市场 → 已安装」页安装并批准审阅卡。

**从本地目录安装** —— 把本目录复制到 `<HANA_HOME>/apps/hanako-localstrata/`，
再到 Hana「市场 → 已安装」页（App 分类下的「待批准」区块）批准。目录名必须等于
manifest 的 `id`。

### 配置

在 Hana 设置页（App **Local Strata**）配置：

| 键 | 默认 | 说明 |
|---|---|---|
| `strataDir` | — | Strata 项目目录；也可在 App 内首次配置表单填写 |
| `pythonPath` | — | Python 解释器；留空则自动探测 `python3` / `python.exe` |
| `configFile` | — | 自动发现 `strata-*.json`，无需手填 |
| `port` | `0` | `0` = 使用所选配置文件里的端口 |
| `autoStart` | `false` | 随 Hana 启动时尝试拉起 Strata |
| `refreshSec` | `5` | 状态刷新间隔（秒）|
| `apiKey` | — | 服务需要时的 Strata API Key |

### 技术说明

- **Windows** 按 Strata 官方 `.bat` 脚本行为实现；**Linux** 是主力测试平台。
  macOS 直接返回「不支持」提示，并隐藏所有操作与配置。
- 更新时的 **CUDA 选择** 以「解释器环境是否自带 `nvcc`」为准（conda 装了
  toolkit），而不是用 `sys.prefix` 猜测。
- 本地推理里没有稳定译法的技术术语（`KV`、`prefill`、`token`、`temperature`、
  `top_p`、`tg` / `pp` 等）在所有语言中都保留原文。

### 开发

```bash
node <hana-app-creator>/scripts/validate_app.mjs --dir . --json
```

需要一个提供 `scripts/validate-app.mjs` 的 Hana 安装
（可用 `HANA_APP_TOOLS_ROOT` 指向 Hana Server 目录）。

### 许可证

[MIT](./LICENSE)
