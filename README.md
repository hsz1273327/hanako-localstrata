# Strata Console

> A Hana app to monitor, configure and control a local **Strata** inference service.

`1.1.1` · Hana `1.1.0-beta`+ · Windows 10/11 & Linux

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
- **Parameter editing** — the config's own values, in six themed groups: model
directory, KV cache, concurrency, experts & memory, draft/speculation, sampling,
plus the shared settings. Changes are shown as a pending diff and written by a
single **Save** (the writer only touches the fields that changed).
- **Model directory** — point this config at another folder of GGUF shards without
  leaving the panel. One field rewrites the three paths that name the model
  (`--native`, `--ple-gguf`, `vision.model`); `--pack`, the tokenizer, the draft
  model and the expert profile stay where they are. The new folder is searched by
  same name, then by the same quantization — a renamed or re-split upload is found,
  and a different size is refused instead of being written in.
- **Concurrency** — a switch, off by default. When on, the number of requests decoded
  together is `parallel`; the tier of your card decides the recommendation and the cap
  (8 GB cannot at all; 12 GB is allowed but discouraged, 2 at most; 16 GB → 2, up to 3;
  above 16 GB → 3, up to 4; above 24 GB → 4, up to 6; above 32 GB → 4, up to 8). The
  panel also shows what the **engine** opened, which can be fewer than configured —
  that is normal, not a failure.
- **Setup with parameters** — “Run setup…” can pass the choices setup takes
  (`--vision`, `--low-ram`, `--kv-streaming`, `--context`, `--kv`, `--gguf-dir`, and a
  pinned `--family`/`--model`), plus “keep the current settings as…” which copies the
  config (and its shared-settings sibling) to a name you choose before the run. Every
  setup this app starts carries `--no-browser`, so a first launch or an update never
  pops a browser window; setup's config records `open_browser: false` and the
  `run-<model>.sh` / `.bat` it writes has no `--open` either.
- **Cards** — the App contributes a whole-page card (everything: status, config, logs,
  the parameter editor) and a slim one: state, model + vision, speed, start/stop. The
  slim view is also the right-hand function panel, so it can sit beside a conversation.
  Dragging it onto a **page** gives you that panel; the desktop surface refuses cards
  that carry one (the host's rule). While the service is stopped, the slim card also
  carries the environment picker (persisted through `POST /profiles/select`); while it
  runs, that spot shows the running profile's name and type, read-only.
- **Logs** — tail of the Strata log.
- **First-run setup** — set the Strata directory, a Python interpreter and
  (optionally) a GGUF model folder in Hana's settings page (App **Local
  Strata**); when no usable config exists the same start button runs `setup.py`
  and then starts the service.
- **Auto-start** — optionally bring Strata up together with Hana.
- **Environment profiles** — each profile is either a **local** Strata source
  checkout or a **container**. Manage them in Hana's settings page (App
  **Local Strata**) and pick one to start on the stop page; while a service is
  running, the in-use profile is locked against edits and deletes. A local profile
  also owns a **required** `dataDir`, the folder setup writes its model data into
  (see *Two deployments on one machine*).

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
- **Container** — Strata running in a Docker container, managed through a
  generated `docker-compose.yml` (falling back to `docker run` when the host has
  no Compose). The profile carries the raw ingredients — image, container name,
  the host model directory and its in-container path, the mount and port lists,
  the engine port pair, env / ulimits / security options and the compose output
  directory — and the picked GPU card model expands into the device request.
  Logs come from `docker compose logs` / `docker logs`.

There are no "modes" and no special cases: MI50, dual-GPU, CUDA 12 vs CUDA 13
are all just different profiles. Both types can coexist on one machine; the
stop page picks which one to launch, and while a service is running the active
profile is locked against edits and deletes (at least one profile always
remains).

**First start** is preserved for both: a local profile with no usable
`strata-*.json` runs `setup.py --setup --gguf-dir …` to generate one, then
starts `serve/server.py`; a container profile performs its own setup inside the
image, driven by the profile's environment and mounts.

The app itself talks to the local Strata API (`127.0.0.1` / `localhost`) and to
`api.github.com` for release checks. Docker is driven through the `docker` CLI,
so pulls do not go through the app's network whitelist.

### Two deployments on one machine

Two deployments on one host (a CUDA checkout next to an ROCm one, a container next
to a source checkout) are supported side by side. Every piece of state that used to
be shared is now per deployment:

- **`dataDir` is a required field of a local profile.** Each local profile owns the
  folder setup writes `models` / `packs` / `mtp` into, and **every** setup and update
  run passes it as `--data-dir`. There is no default and no fallback: a profile saved
  before the field existed is listed in the panel with `dataDir` missing, and setup
  refuses to run instead of guessing a path. (A container profile expresses the same
  place with a `/data` mount plus `STRATA_DATA`.)
- **Each deployment keeps its own setup settings file.** `setup.py` stores `data_dir`
  and `installs` in one per-user `settings.json`, and treats both as folders an older
  install left model files in, moving them into the current run's folder — so two
  deployments overwrote each other's value and migrated each other's data. Setup and
  update runs are now given a config home inside the deployment (`<strataDir>/.config`,
  through `XDG_CONFIG_HOME` on POSIX and `APPDATA` on Windows), written only when
  missing. Nothing to configure and nothing in the UI: an unwritable directory is one
  line in the setup log and the run continues.
- **A process belongs to the deployment it runs from.** Detection used to be one
  machine-wide `pgrep -f serve/server.py`: a stopped profile reported *starting*, its
  Start button answered `already: true`, and Stop could signal the neighbour's pid.
  Detection now accepts only a server whose command line (or, for a `cd <dir> && …`
  launch, whose working directory) points into that Strata directory, and a TCP probe
  on the profile's own resolved port (profile → config file → 8080) is the second,
  independent signal. A listener on the port with none of the deployment's processes
  behind it is reported as a port conflict, and Start says why instead of launching a
  server that cannot bind.
- **Setup never opens a browser.** The first-run job, “Run setup…”, a new config and
  the update's `setup.py --update` all carry `--no-browser`. Starting the service was
  already silent: `serve/server.py` opens a browser only when given `--open`, which
  this app never passes. Container profiles are untouched — their image runs its own
  setup.

### Permissions

On install, Hana shows a review card listing the capabilities this app requests.
All four are required; none is declared "just in case":

| Capability | Why it is needed |
|---|---|
| `app/tools.expose-to-model` | Exposes the `strata_status` / `strata_control` tools so the Agent can read status and start/stop the service. |
| `app/process.spawn` | Starts and stops the Strata process (`python serve/server.py`) and probes the machine: `nvidia-smi` (VRAM), `pgrep` (process detection), `git` (updater). Under Hana's v2 Node sandbox, plain `fs` / `fetch` / `child_process` are blocked, so file probes also go through external commands. **Without this the app cannot control or observe the service.** |
| `app/ui.open-external` | The **Open web UI** button (opens Strata's own page in the browser). |
| `app/ui.clipboard-write` | The **Copy** buttons next to the address and API Key. |

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
| `strataDir` | — | Path to the Strata project (per profile; set in this settings page) |
| `dataDir` | — | **Required** on a local profile: the folder setup writes its model data into (`--data-dir`). A container profile expresses it as a `/data` mount plus `STRATA_DATA` |
| `pythonPath` | — | Python interpreter; empty = auto-detect `python3` / `python.exe` |
| `ggufDir` | — | Local-profile fallback: folder with the GGUF shards (`setup.py --gguf-dir`). A container profile carries its own host-model directory / container path pair instead. Empty = first start downloads the model |
| `configFile` | — | Optional override; empty = auto-use the newest `strata-*.json` (or generate one on first start) |
| `gpu` | — | Optional local GPU selector passed to `serve/server.py --gpu` (e.g. `0`, `0,2`, `all`) |
| `port` | `0` | `0` = use the port from the selected config file |
| `autoStart` | `false` | Try to start the active profile together with Hana |
| `refreshSec` | `5` | Status polling interval, in seconds |
| `defaultApiKey` | — | Default Strata API key (a profile's own key wins; a local config's `api_key` is the last fallback) |
| `apiKey` | — | Legacy global key, migrated into `defaultApiKey` once |
| `profiles` | `[]` | Internal array of environment profiles; manage them in this settings page, not by hand |
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
- **Errors are words, not codes.** The host answers with identifiers
  (`app_surface_session_expired`, …); the card and panel map them to one short sentence
  each, retry once, and back the poll off. A card whose surface session expired cannot
  renew it from inside (the token is minted when the iframe loads), so reopening the card
  is the fix — the line says so instead of showing the code.
- **What is measured vs decided here.** Numbers with a source (0.6 GiB of VRAM per
  concurrency slot, 10–25% slower per request, ~3.6 GB of RAM per slot at 256K) come from
  Strata's own docs and logs; the **VRAM tiers are this App's product rule**, not the
  engine's.

### Development

```bash
node <hana-app-creator>/scripts/validate_app.mjs --dir . --json
```

Requires a Hana install that provides `scripts/validate-app.mjs`
(`HANA_APP_TOOLS_ROOT` can point at the Hana Server directory).

**Packaging** builds from a copy that holds tracked sources only: the packer zips the
directory it is handed, so a `.git` folder or an earlier build sitting inside it ends up
*in* the package (and a `dist-extensions/` in the tree adds a copy of the previous zip).
The directory name has to equal the manifest `id`.

```bash
rsync -a --exclude .git --exclude dist-extensions --exclude node_modules \
  ./ /tmp/pack/hanako-localstrata/
HANA_ROOT=<hana server dir> node <hana-app-creator>/scripts/pack_app.mjs \
  --dir /tmp/pack/hanako-localstrata --publisher <publisher> --out ./dist-extensions
```

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
- **参数编辑** —— 直接改这份 config 的值，按主题分六组：模型目录、KV 缓存、并发、
  专家与内存、草稿/投机、采样，外加上「共享设置」。改动以「待保存改动」对比展示，
  一个**保存**写盘（写入器只动真正变化的字段）。
- **模型目录** —— 不离开面板就能把这份 config 指向另一份 GGUF 分片目录。一个字段
  同时改写三处（`--native`、`--ple-gguf`、`vision.model`）；`--pack`、tokenizer、
  投机草稿、专家档案都留在原处。新目录先按同名找分片，再按同量化找；换了量化就拒绝，
  不会静默写进去。
- **并发** —— 一个开关，默认关。打开后由 `parallel` 决定同时解码几条；按显卡档位给
  推荐与上限（8 GB 不可用；12 GB 可以开但不推荐、最多 2；16 GB 推荐 2、上限 3；
  高于 16 GB 推荐 3、上限 4；高于 24 GB 推荐 4、上限 6；高于 32 GB 推荐 4、上限 8）。
  面板同时显示**引擎实际**开了几个槽，可能少于你设的值 —— 这是正常现象，不是失败。
- **带参数的 setup** —— 「运行 setup…」可以把 setup 的选择传进去（`--vision`、
  `--low-ram`、`--kv-streaming`、`--context`、`--kv`、`--gguf-dir`，以及钉死的
  `--family`/`--model`）；还有「当前设置备份为」，在跑之前把这份 config（连同它的
  shared-settings 兄弟文件）复制成你指定的名字。本 App 起的每一次 setup 都带
  `--no-browser`，首启或更新都不会弹出浏览器窗口；setup 写出的配置里记着
  `open_browser: false`，它生成的 `run-<model>.sh` / `.bat` 也没有 `--open`。
- **卡片** —— 这个 App 提供两张卡：整页卡（全部内容：状态、配置、日志、参数编辑）
  与瘦卡（状态、模型与视觉、速度、启停）。瘦卡也是右侧功能面板的视图，可以停在对话旁边；
  把它拖到**页面**上右栏就会出现；桌面（home）会拒绝带功能面板的卡片（平台规则）。
  服务停止时，瘦卡上也带环境选择器（选中后经 `POST /profiles/select` 落库）；服务运行
  时那个位置显示当前 profile 的名字与类型，只读。
- **日志** —— Strata 日志尾部。
- **首次配置引导** —— 在 Hana 设置页（App **Local Strata**）填写 Strata 目录、
  Python 解释器与（可选的）GGUF 模型目录；没有可用配置时，同一个启动按钮会先跑
  `setup.py` 再启动服务。
- **环境配置（profiles）** —— 每套配置要么是**本机（源码）**、要么是**容器**。
  在 Hana 设置页（App **Local Strata**）管理，在停机页选择要启动的那套；服务运行中
  会锁定正在使用的那套（不允许改 / 删）。本机配置还拥有一个**必填**的 `dataDir`
  ——setup 写模型数据的目录（见「同一台机器上的两套部署」）。
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

本 App 用**环境配置（profiles）**来管理 Strata（在 Hana 设置页的 **Local
Strata** 里增删改）。一套配置就是一种运行 Strata 的方式，分为两类：

- **本机（源码）** —— 在 Strata 目录里跑 `START-HERE.bat`（Windows）或
  `./setup.sh`（Linux）的那种，服务以**本地进程**形式运行 `serve/server.py`。
- **容器** —— 跑在 Docker 容器里的 Strata，由 App 生成的 `docker-compose.yml`
  管理（宿主没有 Compose 时退回 `docker run`）。配置里写的是原始要素：镜像、
  容器名、宿主模型目录与其容器内路径、挂载与端口列表、引擎端口对、
  环境变量 / ulimits / security_opt，以及 compose 落盘目录；选中的显卡型号
  会展开成对应的设备请求。

没有「模式」也没有特例：MI50、双卡、CUDA12 / CUDA13 都只是不同的配置。
同一台机器可以有多套配置；停机页选择要启动的那套，运行中则锁定当前配置
（不允许改 / 删，且至少保留一套）。

**首次启动**在两种配置下都保留：本机配置没有可用 `strata-*.json` 时先跑
`setup.py --setup --gguf-dir …` 生成配置再起服务；容器配置由镜像自身
（entrypoint）完成 setup，取决于该配置的环境变量与挂载。

App 只访问本机 Strata API（`127.0.0.1` / `localhost`），以及用于版本检查的
`api.github.com`。

### 同一台机器上的两套部署

同一台机器上并排跑两套部署（一张 CUDA 卡一套、一张 ROCm 卡一套，或者容器挨着源码
部署）是被支持的。凡是过去可能被共享的状态，现在都按部署分开：

- **`dataDir` 是本机配置的必填字段。** 每套本机配置拥有 setup 写 `models` / `packs` /
  `mtp` 的那个目录，**每次** setup 与更新都会把它作为 `--data-dir` 传进去。没有默认值、
  没有兜底：字段引入之前保存的配置会在面板里显示为缺 `dataDir`，setup 直接拒绝运行，
  而不是替你猜一个路径。（容器配置用 `/data` 挂载加 `STRATA_DATA` 表达同一个位置。）
- **每套部署各自维护自己的 setup 设置文件。** `setup.py` 把 `data_dir` 与 `installs`
  记在一份按用户共享的 `settings.json` 里，并把这两处都当成「旧安装留下的模型目录」，
  把里面的模型文件搬进本次运行的目录——于是两套部署互相覆盖那个值、互相搬走对方的数据。
  现在 setup 与更新的运行会拿到指向部署内部的配置主目录（`<strataDir>/.config`，POSIX
  走 `XDG_CONFIG_HOME`，Windows 走 `APPDATA`），只在缺失时创建。不需要配置，UI 里也没有
  这一项：目录不可写只是 setup 日志里的一行，运行继续。
- **进程属于「它所在的目录」。** 以前检测是一条机器级的 `pgrep -f serve/server.py`：
  停着的配置显示「启动中」，启动按钮返回 `already: true`，停止还会去给隔壁那套的 pid
  发信号。现在只认命令行（`cd <目录> && …` 这种启动方式则认工作目录）指向这套 Strata
  目录的服务进程，再加上「在这套配置自己解析出的端口上做一次 TCP 探测」
  （profile → 配置文件 → 8080）作为第二个独立信号。端口有人在听、却找不到这套部署的
  进程时，按端口冲突上报，启动会直说原因，而不是去起一个绑不上端口的服务。
- **setup 不再弹浏览器。** 首启任务、「运行 setup…」、新建配置，以及更新里的
  `setup.py --update`，全部带 `--no-browser`。启动服务本来就不弹：`serve/server.py`
  只在收到 `--open` 时才开浏览器，本 App 从不传它。容器配置不受影响——它们的 setup
  由镜像自己跑。

### 权限

安装时 Hana 会弹出审阅卡，列出本 App 申请的能力。**四项都是必需，没有一项是「以防万一」才申请的**：

| 能力 | 为什么需要 |
|---|---|
| `app/tools.expose-to-model` | 暴露 `strata_status` / `strata_control` 两个工具，让 Agent 能读状态、启停服务。 |
| `app/process.spawn` | 启停 Strata 进程（`python serve/server.py`），以及探测机器：`nvidia-smi`（显存）、`pgrep`（进程检测）、`git`（更新）。在 Hana v2 的 Node 沙箱下，裸 `fs` / `fetch` / `child_process` 被禁用，因此文件探测也走外部命令。**没有它，App 既无法控制也无法观测服务。** |
| `app/ui.open-external` | **打开网页** 按钮（在浏览器里打开 Strata 自带页面）。 |
| `app/ui.clipboard-write` | 地址与 API Key 旁的 **复制** 按钮。 |

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
| `strataDir` | — | Strata 项目目录（按配置，在本设置页填写） |
| `dataDir` | — | 本机配置**必填**：setup 写模型数据的目录（`--data-dir`）。容器配置用 `/data` 挂载加 `STRATA_DATA` 表达 |
| `pythonPath` | — | Python 解释器；留空则自动探测 `python3` / `python.exe` |
| `ggufDir` | — | 本机配置的模型目录（`setup.py --gguf-dir`）。容器配置在界面上另填宿主模型目录 / 容器内路径。留空则首次启动下载模型 |
| `configFile` | — | 可选覆盖；留空则自动使用最新的 `strata-*.json`（没有则在首次启动时生成） |
| `gpu` | — | 可选的本机 GPU 选择器，传给 `serve/server.py --gpu`（如 `0`、`0,2`、`all`） |
| `port` | `0` | `0` = 使用所选配置文件里的端口 |
| `autoStart` | `false` | 随 Hana 启动时尝试拉起当前配置 |
| `refreshSec` | `5` | 状态刷新间隔（秒）|
| `defaultApiKey` | — | 默认 Strata API Key（配置自带的 key 优先；本机 config 里的 `api_key` 是最后兜底） |
| `apiKey` | — | 旧版全局 key，会被一次性迁移进 `defaultApiKey` |
| `profiles` | `[]` | 内部：环境配置数组；请在本设置页管理，不要手改 |
| `activeProfileId` | `""` | 内部：当前选中配置的 id |

### 技术说明

- **Windows** 按 Strata 官方 `.bat` 脚本行为实现；**Linux** 是主力测试平台。
  macOS 直接返回「不支持」提示，并隐藏所有操作与配置。
- 更新时的 **CUDA 选择** 以「解释器环境是否自带 `nvcc`」为准（conda 装了
  toolkit），而不是用 `sys.prefix` 猜测。
- 本地推理里没有稳定译法的技术术语（`KV`、`prefill`、`token`、`temperature`、
  `top_p`、`tg` / `pp` 等）在所有语言中都保留原文。
- **错误给的是人话，不是错误码。** 宿主会用标识符回答（`app_surface_session_expired` 等），
  卡片与面板把它们映射成一句话，并重试一次、轮询退避。卡片会话过期无法在卡片内部续期
  （票据在 iframe 加载时发出），所以「关掉卡片再打开」就是解法 —— 那行字会直说，而不是甩出内码。
- **哪些是实测、哪些是本 App 定的。** 有出处的数字（并发每槽让出 0.6 GiB 显存、每请求慢
  10–25%、256K 下每槽约 3.6 GB 内存）来自 Strata 自己的文档与日志；**显存分档是本 App 的产品规则**，
  不是引擎的规则。

### 开发

```bash
node <hana-app-creator>/scripts/validate_app.mjs --dir . --json
```

需要一个提供 `scripts/validate-app.mjs` 的 Hana 安装
（可用 `HANA_APP_TOOLS_ROOT` 指向 Hana Server 目录）。

**打包**要从一份只有源码的副本里打：打包器会把交给它的整个目录塞进 zip，所以仓库里
的 `.git`、或者上一次的产物只要在里面，就会跟着进包（树里有个 `dist-extensions/`，包里
就会多出一份上一版 zip）。目录名必须等于 manifest 的 `id`。

```bash
rsync -a --exclude .git --exclude dist-extensions --exclude node_modules \
  ./ /tmp/pack/hanako-localstrata/
HANA_ROOT=<hana server dir> node <hana-app-creator>/scripts/pack_app.mjs \
  --dir /tmp/pack/hanako-localstrata --publisher <publisher> --out ./dist-extensions
```

### 许可证

[MIT](./LICENSE)
