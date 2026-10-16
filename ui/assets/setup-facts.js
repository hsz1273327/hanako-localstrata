// 表一: what a config FILE was built as — read-only, on BOTH pages (the panel's
// 「配置文件」区 and the settings page's 通用 section).
//
// Everything in it is setup's handwriting and has no editable field anywhere:
// the model it installed, whether this config reads images, the engine backend it
// picked, the cards it wrote down, and the two switches only setup can set. It is
// a report, so it carries the read-only block style, and it goes BEFORE the
// controls of its section (what is now, then what can change).
//
// The vision row keeps the two tiers apart, because they are not the same kind of
// choice: whether images are read at all is THIS config's decision (`--vision
// no` vs `yes|cpu|gpu`), while CPU-vs-GPU is a BUILD property — setup compiles a
// different `strata-vision` for the two (`setup.py:3229`) — so it only changes on
// a setup re-run.
import { t, tp } from "./i18n.js";

function make(tag, { className, id, text, i18n, children } = {}) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (id) el.id = id;
  if (i18n) el.dataset.i18n = i18n;
  if (text !== undefined) el.textContent = text;
  if (children) el.replaceChildren(...children);
  return el;
}

// One row per fact. Exported so the tests (and the pages' source guards) can see
// the list instead of re-deriving it.
export const SETUP_FACT_ROWS = [
  { key: "model", label: "setupFacts.model", value: "sf-model" },
  { key: "vision", label: "field.vision", value: "sf-vision", hint: "setupFacts.visionHint" },
  { key: "backend", label: "setupFacts.backend", value: "sf-backend" },
  { key: "gpu", label: "setupFacts.gpu", value: "sf-gpu" },
  // These two keep their element ids: the value mappings below are the same ones
  // the parameter editor used to show, and each carries the line that says where
  // to change it (the 「运行 setup…」 entry).
  { key: "lowRam", label: "edit.lowRam", value: "edit-lowRamMode", hint: "edit.lowRamHint" },
  { key: "kvStreaming", label: "edit.kvStream", value: "edit-kvResident", hint: "edit.kvStreamHint" },
];

const absent = () => "—";

// The low-RAM expert mode, read out of the args by the backend (`lowRamMode`).
export function lowRamModeText(mode) {
  const m = mode === "resident" ? "Resident" : mode === "mmap" ? "Mmap" : "Auto";
  return t(`edit.lowRamMode${m}`);
}

// KV streaming: the PRESENCE of `--kv-resident` is the switch, and its value is
// the attended window setup wrote.
export function kvStreamingText(values) {
  const win = values?.kvResident;
  const on = !(win === undefined || win === null || String(win).trim() === "");
  return on ? tp("edit.kvStreamOn", { n: win }) : t("edit.kvStreamOff");
}

// 视觉, both tiers in one line: "开（读图像）· 编码器 GPU · mmproj …" / "关（不读图像）".
export function visionText(vision) {
  if (!vision || typeof vision !== "object" || !vision.available) return t("vision.off");
  const parts = [t("vision.on")];
  if (vision.encoder === "gpu") parts.push(t("vision.encoderGpu"));
  else if (vision.encoder === "cpu") parts.push(t("vision.encoderCpu"));
  if (vision.mmproj) parts.push(tp("vision.mmproj", { file: vision.mmproj }));
  return parts.join(" · ");
}

// host: the element the block is rendered into (a plain container; the block
// itself, with its read-only class, is built here so both pages look identical).
export function createSetupFacts(host, opts = {}) {
  const p = opts.idPrefix || "sf-";
  const title = make("span", { className: "cf-readonly-label", i18n: "setupFacts.title", text: t("setupFacts.title") });
  const block = make("div", { className: "cf-readonly-item" });
  const values = {};
  const rows = SETUP_FACT_ROWS.map(({ key, label, value, hint }) => {
    const row = make("div", { className: "sf-row" });
    const name = make("span", { className: "sf-label", i18n: label, text: t(label) });
    const val = make("span", { className: "field-hint cf-readonly", id: `${p}${value}`, text: "" });
    values[key] = val;
    row.append(name, val);
    if (hint) {
      row.append(make("span", { className: "field-hint muted", i18n: hint, text: t(hint) }));
    }
    return row;
  });
  block.replaceChildren(title, ...rows);
  if (host) host.replaceChildren(block);

  let last = null;

  function paint(data) {
    const setup = data?.setup || {};
    const flat = data?.values || {};
    values.model.textContent = setup.model ? String(setup.model) : absent();
    values.backend.textContent = setup.backend ? String(setup.backend) : absent();
    values.gpu.textContent = setup.gpu === undefined || setup.gpu === null || setup.gpu === "" ? absent() : String(setup.gpu);
    values.vision.textContent = visionText(data?.vision);
    values.lowRam.textContent = lowRamModeText(flat.lowRamMode);
    values.kvStreaming.textContent = kvStreamingText(flat);
  }

  // No config to describe (a container profile manages its own, or the file could
  // not be read) = nothing to claim: the whole block hides.
  function render(data) {
    last = data;
    const has = !!(data && (data.setup || data.values || data.vision));
    if (host) host.hidden = !has;
    if (!has) return;
    paint(data);
  }

  return {
    block,
    refs: values,
    render,
    // Re-apply the copy after a language change, keeping the values.
    relocalize() {
      for (const el of block.querySelectorAll("[data-i18n]")) {
        el.textContent = t(el.dataset.i18n);
      }
      if (last) paint(last);
    },
  };
}

export default { createSetupFacts, SETUP_FACT_ROWS, visionText, lowRamModeText, kvStreamingText };
