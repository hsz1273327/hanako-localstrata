# Changelog

All notable changes to this App. Versions follow the App's own `manifest.json`
(`version`, plus `minAppVersion` for the Hana build it needs).

## 1.1.0 — 2026-10-18

`manifest.json` says **`1.1.0`**; `minAppVersion` stays at `1.1.0-beta` (that is the Hana
build this App needs, a separate axis from the App's own version).

### Added

- **Concurrency (`parallel`) as a switch.** Off by default (one request at a time, the rest
  queue). Turning it on takes a confirmation that states the measured costs: each extra
  slot takes ~0.6 GiB of VRAM from the expert cache, every request gets ~10–25% slower
  while total throughput rises, and each slot's whole KV lives in RAM (~3.6 GB at 256K).
  The number is pre-filled with the card's recommendation and can be changed within the
  tier's cap: 8 GB cannot, 12 GB is allowed but discouraged (2), 16 GB → 2 (up to 3),
  above 16 GB → 3 (up to 4), above 24 GB → 4 (up to 6), above 32 GB → 4 (up to 8).
  The panel also shows how many slots the **engine** actually opened, which can be fewer
  than configured — normal behaviour, not a failure.
- **Model directory in the parameter editor.** One field rewrites the three paths that
  name the model (`--native`, `--ple-gguf`, `vision.model`). The new folder is resolved by
  file name, then by quantization; a different size or shard count is refused instead of
  being written. `--pack`, the tokenizer, the draft model and the expert profile stay put.
- **Parameters for “Run setup…”**: `--vision`, `--low-ram`, `--kv-streaming`, `--context`,
  `--kv`, `--gguf-dir`, and a pinned `--family`/`--model` (so a re-run cannot silently
  downgrade the size). “Keep the current settings as …” copies the config and its
  shared-settings sibling under a name you choose.
- **Tuning knobs** in the parameter editor: VRAM reserve, prompt chunking, CPU expert
  workers, elastic VRAM, spec-min-p, suffix draft length, parked-conversation slots.
- **A slim card and a right-hand function panel** (`/card.html`): service state, model and
  whether it reads images, decode/prefill speed, start/stop. The whole page
  (`/panel.html`) keeps everything else.

### Fixed

- Host error codes no longer reach the screen: `app_surface_session_expired` and friends
  become one short sentence, the request is retried once, and the poll backs off instead
  of hammering a dead session.
- The concurrency switch snapped back to the file's value on every refresh (it looked
  unclickable): the switch's checked state is now only set when a config is loaded.
- A concurrency-like checkbox no longer inherits the full-width text-input box (the empty
  green slab), and the parameter editor's Save is centred at action width instead of
  sitting in the first column of a leftover two-column grid.
- Writing a value that equals the stored one no longer fails as “flag not found”.
- Cards whose model line came from the address line now show the model and a vision icon
  instead of a URL.
- The Performance block no longer disappears when the metrics window is momentarily
  empty, and metrics are read from the log the config declares rather than whichever log
  file has the newest mtime.

### Changed

- Parameter editing is grouped by subject (model, KV cache, concurrency, experts &
  memory, draft/speculation, sampling, shared); a single **Save** writes only the fields
  that changed.
- `parallel` is written as a top-level config key (1 means “remove the key”), not as an
  engine arg.
- The page card keeps the site-navigation entry; the slim card is the one that can be
  dragged onto a page and carries the function panel.

### Not verified on real hardware

Anything that needs a click: the concurrency switch and its confirmation dialog, the
right-hand panel appearing on drag, and the tier copy at each card size (the tiers
themselves are unit-tested against the specification's boundaries).
