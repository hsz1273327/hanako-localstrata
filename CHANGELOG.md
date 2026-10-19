# Changelog / 更新日志

All notable changes to this App. Versions follow the App's own `manifest.json`
(`version`, plus `minAppVersion` for the Hana build it needs).
本 App 的重要变更。版本号取自 `manifest.json` 的 `version`；`minAppVersion` 指它需要的
Hana 构建版本，是另一条轴。

## 1.1.0 — 2026-10-18

`manifest.json` says **`1.1.0`**; `minAppVersion` stays at `1.1.0-beta` (that is the Hana
build this App needs, a separate axis from the App's own version).
`manifest.json` 里是 **`1.1.0`**；`minAppVersion` 仍是 `1.1.0-beta`（那是它需要的 Hana
构建版本，与本 App 的版本号是两条轴）。

### Added / 新增

- **Concurrency (`parallel`) as a switch.** Off by default (one request at a time, the rest
  queue). Turning it on takes a confirmation that states the measured costs: each extra
  slot takes ~0.6 GiB of VRAM from the expert cache, every request gets ~10–25% slower
  while total throughput rises, and each slot's whole KV lives in RAM (~3.6 GB at 256K).
  The number is pre-filled with the card's recommendation and can be changed within the
  tier's cap: 8 GB cannot, 12 GB is allowed but discouraged (2), 16 GB → 2 (up to 3),
  above 16 GB → 3 (up to 4), above 24 GB → 4 (up to 6), above 32 GB → 4 (up to 8).
  The panel also shows how many slots the **engine** actually opened, which can be fewer
  than configured — normal behaviour, not a failure.

  **并发（`parallel`）是一个开关。** 默认关闭（一次一个请求，其余排队）。打开时会先确认，
  并写明实测代价：每多一路，专家缓存让出约 0.6 GiB 显存；每请求慢约 10–25%，但总吞吐上升；
  每路整段 KV 都在内存里（256K 时约 3.6 GB）。数值按显卡档位预填推荐值，可在该档上限内调整：
  8 GB 不可用，12 GB 可开但不推荐（2），16 GB → 2（上限 3），高于 16 GB → 3（上限 4），
  高于 24 GB → 4（上限 6），高于 32 GB → 4（上限 8）。面板还会显示**引擎实际**开了几个槽，
  可能少于你设的值——这是正常现象，不是失败。
- **Model directory in the parameter editor.** One field rewrites the three paths that
  name the model (`--native`, `--ple-gguf`, `vision.model`). The new folder is resolved by
  file name, then by quantization; a different size or shard count is refused instead of
  being written. `--pack`, the tokenizer, the draft model and the expert profile stay put.

  **参数编辑里的「模型目录」。** 一个字段同时改写三处（`--native`、`--ple-gguf`、
  `vision.model`）。新目录先按同名找分片，再按同量化找；量化或分片数不一致就拒绝，不会写进去。
  `--pack`、tokenizer、投机草稿、专家档案都留在原处。
- **Parameters for "Run setup…"**: `--vision`, `--low-ram`, `--kv-streaming`, `--context`,
  `--kv`, `--gguf-dir`, and a pinned `--family`/`--model` (so a re-run cannot silently
  downgrade the size). "Keep the current settings as …" copies the config and its
  shared-settings sibling under a name you choose.

  **「运行 setup…」可传参**：`--vision`、`--low-ram`、`--kv-streaming`、`--context`、
  `--kv`、`--gguf-dir`，以及钉死的 `--family`/`--model`（这样重跑不会静默降档）。
  「当前设置备份为 …」会在跑之前，把这份 config 连同它的 shared-settings 兄弟文件
  复制成你指定的名字。
- **Tuning knobs** in the parameter editor: VRAM reserve, prompt chunking, CPU expert
  workers, elastic VRAM, spec-min-p, suffix draft length, parked-conversation slots.

  **调优参数**（参数编辑里）：显存保留、prompt 分块、CPU 专家线程数、弹性显存、
  spec-min-p、suffix 草稿长度、停放会话槽位。
- **A slim card and a right-hand function panel** (`/card.html`): service state, model and
  whether it reads images, decode/prefill speed, start/stop. The whole page
  (`/panel.html`) keeps everything else.

  **瘦卡与右侧功能面板**（`/card.html`）：服务状态、模型与是否带视觉、解码/预取速度、
  启停。整页（`/panel.html`）保留其余全部功能。

### Fixed / 修复

- Host error codes no longer reach the screen: `app_surface_session_expired` and friends
  become one short sentence, the request is retried once, and the poll backs off instead
  of hammering a dead session.

  **宿主错误码不再上屏。** `app_surface_session_expired` 这类会变成一句人话，请求先重试一次，
  轮询改为退避，不再反复砸一个已失效的会话。
- The concurrency switch snapped back to the file's value on every refresh (it looked
  unclickable): the switch's checked state is now only set when a config is loaded.

  **并发开关会自己弹回（表现为「点不了」）。** 现在只在载入配置时写勾选状态，刷新不再覆盖。
- A concurrency-like checkbox no longer inherits the full-width text-input box (the empty
  green slab), and the parameter editor's Save is centred at action width instead of
  sitting in the first column of a leftover two-column grid.

  **勾选框不再继承文本输入框的全宽边框**（那块空绿牌子）；参数编辑的「保存」改为居中、
  动作宽度，不再占着遗留两列网格的第一列。
- Writing a value that equals the stored one no longer fails as "flag not found".

  **把值写成它已有的值不再报错。** 以前会被当成「找不到参数」。
- Cards whose model line came from the address line now show the model and a vision icon
  instead of a URL.

  **卡片底部改为显示模型与视觉。** 原来那行地址换成了模型名和一个视觉图标。
- The update action no longer disappears while the service is stopped. The local version
  used to come only from the running server's status, so a stopped service showed
  "version: —" and the update row collapsed to a bare version number — although stopping
  is the update pipeline's own first step. It now also reads the engine's
  `engine/BUILD.json`, and an unknown local version counts as "not provably up to date",
  so the update button is offered.

  **服务停止时也能更新了。** 本地版本以前只取自运行中服务的状态，停机就显示
  「版本 —」，更新那一行只剩一个版本号——而更新流程本来就是先停服。现在同时读引擎的
  `engine/BUILD.json`；本地版本未知时按「无法确认是否最新」处理，因此仍会给出更新入口。
- The Performance block no longer disappears when the metrics window is momentarily
  empty, and metrics are read from the log the config declares rather than whichever log
  file has the newest mtime.

  **「性能」块不再整块消失。** 指标短暂为空时只显示 `—`；指标改为读 config 声明的那份日志，
  不再取 mtime 最新的那个日志文件。

### Changed / 变更

- Parameter editing is grouped by subject (model, KV cache, concurrency, experts &
  memory, draft/speculation, sampling, shared); a single **Save** writes only the fields
  that changed.

  **参数编辑按主题分组**（模型、KV 缓存、并发、专家与内存、草稿/投机、采样、共享）；
  一个**保存**只写真正变化的字段。
- `parallel` is written as a top-level config key (1 means "remove the key"), not as an
  engine arg.

  **`parallel` 改为顶层 config 键**（值为 1 表示删掉这个键），不再走引擎参数。
- The page card keeps the site-navigation entry; the slim card is the one that can be
  dragged onto a page and carries the function panel.

  **两张卡分工**：整页卡保留站点导航入口；能拖到页面上、并带右侧功能面板的是瘦卡。

### Not verified on real hardware / 未在真机验证

Anything that needs a click: the concurrency switch and its confirmation dialog, the
right-hand panel appearing on drag, and the tier copy at each card size (the tiers
themselves are unit-tested against the specification's boundaries).

凡是需要"点一下"的都没实测：并发开关与它的确认框、拖拽后右栏是否出现、各档位文案的实际观感
（分档规则本身已按规格边界做了单元测试）。
