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
- **Version check + one-click update** — reads the latest release; the local
  source update pipeline stops the service, updates the checkout and restarts.
  Container profiles are updated out of band (no in-app image build).
- **Resources** — VRAM and RAM bars.
- **Performance** — generation `tg`, prefill `pp`, expert-cache hit rate and
  KV hit rate.
- **Parameter editing** — context length, KV quantization, session cache,
  sampling parameters, max output and reasoning effort, with a pending-change
  diff and a "save & restart" action.
- **Logs** — tail of the Strata log.
- **First-run setup** — point at the Strata directory, a Python interpreter
  and (optionally) a GGUF model folder; when no usable config exists the same
  start button runs `setup.py` and then starts the service.
- **Auto-start** — optionally bring Strata up together with Hana.
- **Environment profiles** — each profile is either a **local** Strata source
  checkout or a **container**. Manage them on the configuration page and pick
  one to start on the stop page; while a service is running, profiles are
  locked (no edit/delete).

### Requirements

| Item | Requirement |
|---|---|
| Hana | **`1.1.0-beta` or newer** |
| Platform | **Windows 10/11**, **Linux** — macOS is not supported by Strata |
| Strata | A deployed Strata checkout plus a Python environment, **or** a container image (e.g. a Docker image you built or a community image) |
| Update feature | `git` and a CUDA toolchain if you use the in-app updater |

> ⚠️ **This is a Hana v2 App — it does NOT work on Hana v1.**
> v2 Apps install under `<HANA_HOME>/apps/` and use `manifestVersion: 2`.
> If you have an older Hana (v1 plugin system, `<HANA_HOME>/plugins/`), this app
> will not load. Uninstall any previous **v1** version of this plugin before
> installing, then approve the v2 app from *Market → Installed*.

### Scope

This app manages Strata through **environment profiles**. A profile is just "one
way to run Strata" and is either:

- **Local (source)** — the one you get by running `START-HERE.bat` (Windows) or
  `./setup.sh` (Linux) in a Strata checkout, which runs `serve/server.py` **as a
  local process**. Start/stop uses process signals, config is a writable
  `strata-*.json`, logs are files under the checkout.
- **Container** — Strata running in a Docker container. Start/stop uses
  `docker start` / `docker stop`, config is read from the `/data` volume (and
  written back through `docker cp`), logs come from `docker logs` and the
  container's writable layer. When the container does not exist yet the app
  creates it from a generic Strata recipe (image, container name, data and GGUF
  directories, published port); special hardware can be used by pre-creating the
  container yourself.

There are no "modes" and no special cases: MI50, dual-GPU, CUDA 12 vs CUDA 13
are all just different profiles. Both types can coexist on one machine; the
stop page picks which one to launch, and while a service is running the active
profile is locked against edits and deletes (at least one profile always
remains).

**First start** is preserved for both: a local profile with no usable
`strata-*.json` runs `setup.py --setup --gguf-dir …` to generate one, then
starts `serve/server.py`; a container profile is started with `GGUF_DIR` +
`STRATA_DATA` so the entrypoint performs its own setup.

The app itself talks to the local Strata API (`127.0.0.1` / `localhost`) and to
`api.github.com` for release checks. Docker is driven through the `docker` CLI,
so pulls do not go through the app's network whitelist.

### Permissions

On install, Hana shows a review card listing the capabilities this app requests.
All four are required; none is declared "just in case":

| Capability | Why it is needed |
|---|---|
| `app/tools.expose-to-model` | Exposes the `strata_status` / `strata_control` tools so the Agent can read status and start/stop the service. |
| `app/process.spawn` | Starts and stops the Strata process (`python serve/server.py`) and probes the machine: `nvidia-smi` (VRAM), `pgrep` (process detection), `git` (updater). Under Hana's v2 Node sandbox, plain `fs` / `fetch` / `child_process` are blocked, so file probes also go through external commands. **Without this the app cannot control or observe the service.** |
| `app/ui.open-external` | The **Open web UI** button (opens Strata's own page in the browser). |
| `app/ui/clipboard-write` | The **Copy** buttons next to the address and API Key. |

**Network**: only `127.0.0.1` / `localhost` (the local Strata API) and
`api.github.com` (version check). Nothing is sent anywhere else.

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
| `ggufDir` | — | Folder with the GGUF shards. Local: `setup.py --gguf-dir`. Container: mounted at `/gguf` + `GGUF_DIR`. Empty = first start downloads the model |
| `configFile` | — | Optional override; empty = auto-use the newest `strata-*.json` (or generate one on first start) |
| `gpu` | — | Optional local GPU selector passed to `serve/server.py --gpu` (e.g. `0`, `0,2`, `all`) |
| `port` | `0` | `0` = use the port from the selected config file |
| `autoStart` | `false` | Try to start the active profile together with Hana |
| `refreshSec` | `5` | Status polling interval, in seconds |
| `apiKey` | — | Strata API key, if the service requires one |
| `profiles` | `""` | Internal JSON array of environment profiles; manage from the panel, not the Hana settings form |
| `activeProfileId` | `""` | Internal: id of the currently selected profile |

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
| Hana | **`1.1.0-beta` 或更新** |
| 平台 | **Windows 10/11**、**Linux**；macOS 不被 Strata 支持 |
| Strata | 已部署的 Strata 目录 + Python 环境 |
| 更新功能 | 使用内置更新时需要 `git` 与 CUDA 工具链 |

> ⚠️ **这是 Hana v2 App，在 Hana v1 上无法使用。**
> v2 App 安装到 `<HANA_HOME>/apps/`，使用 `manifestVersion: 2`。
> 旧版 Hana（v1 插件体系，`<HANA_HOME>/plugins/`）无法加载本 App。
> 若之前装过本插件的 **v1** 版本，请先卸载，再在「市场 → 已安装」批准 v2 版本。

### 适用范围

本 App 用**环境配置（profiles）**来管理 Strata。一套配置就是一种运行
Strata 的方式，分为两类：

- **本机（源码）** —— 在 Strata 目录里跑 `START-HERE.bat`（Windows）或
  `./setup.sh`（Linux）的那种，服务以**本地进程**形式运行 `serve/server.py`。
- **容器** —— 跑在 Docker 容器里的 Strata。容器不存在时，App 用通用配方
  （镜像、容器名、数据目录、GGUF 目录、端口）创建；特殊硬件可自行预先创建容器。

没有「模式」也没有特例：MI50、双卡、CUDA12 / CUDA13 都只是不同的配置。
同一台机器可以有多套配置；停机页选择要启动的那套，运行中则锁定当前配置
（不允许改 / 删，且至少保留一套）。

**首次启动**在两种配置下都保留：本机配置没有可用 `strata-*.json` 时先跑
`setup.py --setup --gguf-dir …` 生成配置再起服务；容器配置以 `GGUF_DIR` +
`STRATA_DATA` 启动，由 entrypoint 自行 setup。

App 只访问本机 Strata API（`127.0.0.1` / `localhost`），以及用于版本检查的
`api.github.com`。

### 权限

安装时 Hana 会弹出审阅卡，列出本 App 申请的能力。**四项都是必需，没有一项是「以防万一」才申请的**：

| 能力 | 为什么需要 |
|---|---|
| `app/tools.expose-to-model` | 暴露 `strata_status` / `strata_control` 两个工具，让 Agent 能读状态、启停服务。 |
| `app/process.spawn` | 启停 Strata 进程（`python serve/server.py`），以及探测机器：`nvidia-smi`（显存）、`pgrep`（进程检测）、`git`（更新）。在 Hana v2 的 Node 沙箱下，裸 `fs` / `fetch` / `child_process` 被禁用，因此文件探测也走外部命令。**没有它，App 既无法控制也无法观测服务。** |
| `app/ui.open-external` | **打开网页** 按钮（在浏览器里打开 Strata 自带页面）。 |
| `app/ui/clipboard-write` | 地址与 API Key 旁的 **复制** 按钮。 |

**网络**：仅 `127.0.0.1` / `localhost`（本机 Strata API）与 `api.github.com`
（版本检查），不向其它任何地方发送数据。

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
| `ggufDir` | — | 含全部分片 GGUF 的目录。本机：`setup.py --gguf-dir`；容器：挂载到 `/gguf` 并传 `GGUF_DIR`。留空则首次启动下载模型 |
| `configFile` | — | 可选覆盖；留空则自动使用最新的 `strata-*.json`（没有则在首次启动时生成） |
| `gpu` | — | 可选的本机 GPU 选择器，传给 `serve/server.py --gpu`（如 `0`、`0,2`、`all`） |
| `port` | `0` | `0` = 使用所选配置文件里的端口 |
| `autoStart` | `false` | 随 Hana 启动时尝试拉起当前配置 |
| `refreshSec` | `5` | 状态刷新间隔（秒）|
| `apiKey` | — | 服务需要时的 Strata API Key |
| `profiles` | `""` | 内部：环境配置的 JSON 数组；请在面板里管理，不要手改 |
| `activeProfileId` | `""` | 内部：当前选中配置的 id |

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
