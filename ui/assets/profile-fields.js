// ui/assets/profile-fields.js — the shared container-profile field block.
//
// The panel drawer and the settings page both edit a container profile, and the
// container model (lib/profiles.js) grew a full field set: a card-model picker
// whose *vendor* decides whether "which cards" even applies, two `a:b` list
// fields, a stack of docker passthrough lists, and a compose output directory.
// Hand-writing that twice is exactly how two forms drift apart, so this module
// is the single source for those fields. It renders them into a host element,
// owns the vendor split and the add/remove row controls, and reads them back in
// the shape the save route expects. Each page keeps only the glue it alone can
// do: loading the catalog, applying the MI50 preset, and the image
// availability/pull row that differs between the two surfaces.
//
// Deliberately NOT here: the image name/tag, the container name and the
// profile name/type. Those already exist per page with page-specific extras (a
// datalist + availability line vs. a re-pull button) and are unchanged.
//
// No docker device vocabulary ever reaches the UI: the picked card model
// implies it and lib/gpu.js expands it.
import { t, tp, applyI18n } from "./i18n.js";

const NVIDIA = "nvidia";
const AMD = "amd";
// The container's vision switch, mirroring lib/profiles.js `VISION_VALUES` (this
// asset cannot import the Node-side model; a test keeps the two in step). The
// image reads `VISION` from the environment and defaults it to `no`.
export const VISION_OPTIONS = ["no", "yes", "cpu"];
// A row cap so a paste accident cannot produce an unbounded form / config.
const MAX_LIST = 32;

// ── tiny DOM helpers ──────────────────────────────────────────────────────

function make(tag, opts = {}) {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.id) node.id = opts.id;
  if (opts.type) node.type = opts.type;
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.value !== undefined) node.value = opts.value;
  if (opts.placeholder !== undefined) node.placeholder = opts.placeholder;
  for (const [key, value] of Object.entries(opts.attrs || {})) node.setAttribute(key, value);
  for (const child of opts.children || []) if (child) node.append(child);
  return node;
}

function i18nSpan(key, cls) {
  return make("span", { class: cls, attrs: { "data-i18n": key } });
}

function i18nHint(key) {
  return make("span", { class: "field-hint", attrs: { "data-i18n": key } });
}

function numOr0(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : 0;
}

// Pure: which vendor a card-model key belongs to. The catalog is authoritative;
// before it has answered, the key's own prefix is a safe hint that can never
// contradict a later catalog entry the way a wrong default would. Exported so
// the split rule can be unit tested without a DOM.
export function gpuVendorOf(models, key) {
  const wanted = String(key ?? "").trim();
  if (!wanted) return "";
  const entry = (Array.isArray(models) ? models : []).find((m) => m && m.key === wanted);
  if (entry) return entry.vendor || "";
  if (wanted === NVIDIA) return NVIDIA;
  if (wanted.startsWith("amd")) return AMD;
  return "";
}

// Only an NVIDIA card is asked for one by one; an AMD card is handed over as
// ROCm device nodes, so the per-card picker does not apply there.
export function gpuIdsApplies(models, key) {
  return gpuVendorOf(models, key) === NVIDIA;
}

// ── the API key control (shared by BOTH profile types) ────────────────────
//
// A local profile and a container profile carry the same override field, and the
// page has the same three questions for either: what is set, does it come back
// masked, and WHICH key is actually in effect. So the control is one factory that
// either surface mounts:
//   * createContainerFields puts it in its advanced group;
//   * the local block mounts it straight into its own host (see the pages).
// The type never enters here — the only difference is whether the page can name a
// config file, which shows up as the third line below (a local-only thing).
//
// `host` is optional: pass it to mount immediately, or take `.field` and place it
// yourself.
export function createApiKeyField(host, opts = {}) {
  const p = opts.idPrefix || "cf-";
  const apiKeySource = typeof opts.apiKeySource === "function" ? opts.apiKeySource : null;

  const input = make("input", {
    id: `${p}api-key`,
    type: "password",
    attrs: { autocomplete: "off", spellcheck: "false", "data-i18n-placeholder": "field.apiKeyPlaceholder" },
  });
  const dot = make("span", { class: "cf-key-dot" });
  dot.hidden = true;
  const text = make("span", { class: "cf-key-text" });
  const source = make("p", { class: "field-hint cf-key-source", children: [dot, text] });
  const field = make("label", {
    class: "field",
    children: [i18nSpan("field.apiKey"), input, source, i18nHint("field.apiKeyHint")],
  });

  // "Which key is in effect?" — this profile's override, else the global fallback,
  // else (when the page can name one) the selected config file's `api_key`.
  // Only a file NAME ever arrives here; never a value.
  //
  // The override is a STATUS (what is in effect is not the config's / global's
  // key), so it gets a state dot and the App's existing attention amber. Never the
  // green accent: on this screen green already means the running/selected profile.
  // The other two states carry no marker, but every variant leads with its state
  // (overridden / not overridden) so the three read as parallel facts.
  function refreshSource() {
    const override = input.value.trim() !== "";
    dot.hidden = !override;
    if (override) source.classList.add("is-override");
    else source.classList.remove("is-override");
    let message;
    if (override) {
      message = t("field.apiKeySourceOverride");
    } else {
      const src = apiKeySource ? apiKeySource() : null;
      const file = src && src.file ? String(src.file) : "";
      message = file ? tp("field.apiKeySourceConfig", { file }) : t("field.apiKeySourceGlobal");
    }
    text.textContent = message;
  }

  // `value` may be the mask the backend returned; it round-trips as "unchanged".
  function render(value) {
    input.value = value === undefined || value === null ? "" : String(value);
    refreshSource();
  }
  function value() {
    return input.value.trim();
  }
  function setReadOnly(flag) {
    input.disabled = !!flag;
  }
  function relocalize() {
    applyI18n(field);
    refreshSource();
  }

  input.addEventListener("input", refreshSource);
  input.addEventListener("change", refreshSource);
  if (host) host.append(field);

  return { field, refs: { input, source, dot, text }, render, value, setReadOnly, relocalize, refreshSource };
}

// ── the local vision state (read-only) ───────────────────────────────────
//
// A local deployment's `vision` block is written by setup.py — it downloads the
// encoder, pins whether it runs on the GPU or the CPU, and writes the mmproj path
// — so the app REPORTS it instead of offering an edit. That is not just tidiness:
// the CPU/GPU choice is a property of the `strata-vision` BINARY setup compiled
// (`setup.py:3229`, `-DSTRATA_VISION_CUDA=ON/OFF` for --vision gpu / anything
// else), and the engine's args carry a per-mode `--vram-reserve-mib`
// (`setup.py:5416`). Flipping `vision.gpu` in the config would point at a binary
// built for the other mode, so the switch belongs to setup — the engine itself
// says as much (`serve/server.py:2174-2181`: it tolerates a hand-edited section,
// then prints "run setup again with --vision to write them").
//
// A container keeps its config inside the container and passes `null`, which
// hides the line.
export function createVisionStatus(host, opts = {}) {
  const p = opts.idPrefix || "cf-";
  // 视觉 is its own section on BOTH sides, under the same name: image input is a
  // subject, not a footnote in the advanced long tail. The shape differs on
  // purpose — this side reports the block setup wrote (see above), while the
  // container side offers the image's own `Vision` switch — so they never pretend
  // to be one control.
  const section = make("div", { class: "cf-section cf-section-vision", attrs: { role: "group" } });
  const line = make("p", { class: "field-hint cf-readonly", id: `${p}vision-status` });
  section.replaceChildren(i18nSpan("field.vision", "cf-section-title"), line, i18nHint("vision.setupNote"));
  let lastInfo = null;

  function paint(info) {
    if (!info || typeof info !== "object") {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    if (!info.available) {
      line.textContent = t("vision.off");
      return;
    }
    const parts = [t("vision.on")];
    // Name the mode in BOTH vocabularies: a local install spells the GPU case
    // `gpu` (setup.py --vision gpu), the container image spells it `yes`.
    if (info.encoder === "gpu") parts.push(t("vision.encoderGpu"));
    else if (info.encoder === "cpu") parts.push(t("vision.encoderCpu"));
    if (info.mmproj) parts.push(tp("vision.mmproj", { file: info.mmproj }));
    line.textContent = parts.join(" · ");
  }

  const api = {
    field: section,
    refs: { line },
    render(info) {
      lastInfo = info;
      applyI18n(section);
      paint(info);
    },
    relocalize() {
      applyI18n(section);
      paint(lastInfo);
    },
  };
  if (host) host.append(section);
  section.hidden = true;
  return api;
}

// ── the module ────────────────────────────────────────────────────────────

// host: the element the fields are rendered into.
// opts:
//   idPrefix     – id stem so a page can address the inputs (default "cf-").
//   api          – the page's (path, init) => Promise fetcher, for the deploy
//                  path probe. Optional; without it the resolved path is hidden.
//   pickPath     – (input, mode, notify) => void, the host directory picker.
//   openDir      – (path) => void, optional "open folder" action.
//   copyText     – (text) => void, optional clipboard action.
//   notify       – (text, kind) => void, the page's message sink.
//   preset       – render the community-image prompt slot (settings page).
//   profileId    – () => string, the edited profile id (deploy path fallback).
//   containerName– () => string, the edited container name (deploy path).
//   onChange     – () => void, called after the card model changes (preset).
export function createContainerFields(host, opts = {}) {
  const p = opts.idPrefix || "cf-";
  const api = typeof opts.api === "function" ? opts.api : null;
  const pickPath = typeof opts.pickPath === "function" ? opts.pickPath : null;
  const openDir = typeof opts.openDir === "function" ? opts.openDir : null;
  const copyText = typeof opts.copyText === "function" ? opts.copyText : null;
  const notify = typeof opts.notify === "function" ? opts.notify : () => {};
  const withPreset = !!opts.preset;
  const apiKeySource = typeof opts.apiKeySource === "function" ? opts.apiKeySource : null;
  const profileId = typeof opts.profileId === "function" ? opts.profileId : () => "";
  const containerNameOf = typeof opts.containerName === "function" ? opts.containerName : () => "";
  const onChange = typeof opts.onChange === "function" ? opts.onChange : () => {};

  let catalog = [];
  let readOnly = false;
  let deployToken = 0;
  // Container fields the module owns, and the identity fields the page owns.
  // Everything else a profile carries (today: the template-contributed device
  // cgroup rules, which have no input) is preserved through a save without ever
  // being named — or shown — by the interface.
  const OWNED_KEYS = new Set([
    "GpuModel",
    "GpuIds",
    "ModelDir",
    "ModelsBindDir",
    "EnginePort",
    "EngineBindPort",
    "VolumeBinds",
    "PortBinds",
    "environment",
    "ulimits",
    "security_opt",
    "ShmSize",
    "ApiKeyEnv",
    "Vision",
    "apiKey",
    "DeployDir",
  ]);
  const PAGE_OWNED_SKIP = new Set([
    "id",
    "name",
    "type",
    "image",
    "imageName",
    "imageTag",
    "containerName",
    // Legacy flat fields: re-sending them would re-trigger the migration
    // (dataDir → a /data mount, ggufDir → the /gguf env, …).
    "dataDir",
    "ggufDir",
    "port",
    "configFile",
  ]);
  let carried = {};

  // ── card model + vendor split ─────────────────────────────────────────

  const gpuModel = make("select", { id: `${p}gpu-model` });

  const amdNote = make("p", {
    class: "field-hint cf-vendor-note",
    attrs: { "data-i18n": "field.gpuAmdNote" },
    hidden: true,
  });
  amdNote.hidden = true;

  const presetBox = withPreset
    ? make("div", {
        class: "preset-box",
        id: `${p}preset`,
        children: [
          make("p", { class: "field-hint", id: `${p}preset-text` }),
          make("div", {
            class: "field-inline",
            children: [
              make("button", {
                class: "btn small",
                id: `${p}preset-apply`,
                type: "button",
                attrs: { "data-i18n": "preset.apply" },
              }),
              make("button", {
                class: "btn small",
                id: `${p}preset-ignore`,
                type: "button",
                attrs: { "data-i18n": "preset.ignore" },
              }),
            ],
          }),
        ],
      })
    : null;
  if (presetBox) presetBox.hidden = true;

  const gpuModelField = make("label", {
    class: "field",
    children: [i18nSpan("field.gpuModel"), gpuModel, amdNote],
  });

  // ── "which cards" — NVIDIA only ───────────────────────────────────────

  const gpuIds = make("input", {
    id: `${p}gpu-ids`,
    type: "text",
    attrs: { autocomplete: "off", spellcheck: "false", "data-i18n-placeholder": "field.gpuIdsPlaceholder" },
  });
  const gpuIdsField = make("label", {
    class: "field",
    children: [i18nSpan("field.gpuIds"), gpuIds, i18nHint("field.gpuIdsHint")],
  });
  gpuIdsField.hidden = true;

  function vendorOf(key) {
    return gpuVendorOf(catalog, key);
  }

  // The split, in one place: NVIDIA cards are requested one by one (the model
  // template turns an id list into a device reservation), an AMD card is
  // requested by handing over the ROCm device nodes, so "which cards" has no
  // meaning there and the control is hidden *and cleared* — a stale value would
  // otherwise ride along invisibly.
  function applyVendorSplit() {
    const vendor = vendorOf(gpuModel.value);
    const nvidia = vendor === NVIDIA;
    gpuIdsField.hidden = !nvidia;
    if (!nvidia && gpuIds.value) gpuIds.value = "";
    amdNote.hidden = vendor !== AMD;
  }

  gpuModel.addEventListener("change", () => {
    applyVendorSplit();
    onChange();
  });

  // ── simple scalars ────────────────────────────────────────────────────

  function textField(key, labelKey, placeholderKey, hintKey, extra = []) {
    const input = make("input", {
      id: `${p}${key}`,
      type: "text",
      attrs: { autocomplete: "off", spellcheck: "false", "data-i18n-placeholder": placeholderKey },
    });
    const children = [i18nSpan(labelKey), input, ...extra, i18nHint(hintKey)];
    const field = make("label", { class: "field", children });
    return { field, input };
  }

  function numberField(key, labelKey, hintKey) {
    const input = make("input", {
      id: `${p}${key}`,
      type: "number",
      attrs: { min: "0", max: "65535", step: "1", inputmode: "numeric" },
    });
    const field = make("label", { class: "field", children: [i18nSpan(labelKey), input, i18nHint(hintKey)] });
    return { field, input };
  }

  // A path field: the text input plus the host picker, when one is available.
  function pathField(key, labelKey, placeholderKey, hintKey) {
    const input = make("input", {
      id: `${p}${key}`,
      type: "text",
      attrs: { autocomplete: "off", spellcheck: "false", "data-i18n-placeholder": placeholderKey },
    });
    const extra = [];
    if (pickPath) {
      const button = make("button", {
        class: "btn small cf-pick",
        type: "button",
        attrs: { "data-i18n": "field.pickPath" },
      });
      button.addEventListener("click", async () => {
        const before = input.value;
        await pickPath(input, "directory", notify);
        // The picker writes the value programmatically, which fires no event of
        // its own — so a pick would otherwise leave every listener (the deploy
        // path preview included) showing the previous answer. Emit the same
        // signal a committed user edit does.
        if (input.value !== before) {
          try {
            input.dispatchEvent(new Event("change", { bubbles: true }));
          } catch {
            /* environments without the Event constructor: typing still works */
          }
        }
      });
      extra.push(make("div", { class: "field-inline", children: [button] }));
    }
    const field = make("label", { class: "field", children: [i18nSpan(labelKey), input, ...extra, i18nHint(hintKey)] });
    return { field, input };
  }

  const modelDir = pathField("model-dir", "field.modelDir", "field.modelDirPlaceholder", "field.modelDirHint");
  const modelsBindDir = textField(
    "models-bind-dir",
    "field.modelsBindDir",
    "field.modelsBindDirPlaceholder",
    "field.modelsBindDirHint",
  );
  const enginePort = numberField("engine-port", "field.enginePort", "field.enginePortHint");
  const engineBindPort = numberField("engine-bind-port", "field.engineBindPort", "field.engineBindPortHint");
  const shmSize = textField("shm-size", "field.shmSize", "field.shmSizePlaceholder", "field.shmSizeHint");
  const apiKeyEnv = textField("api-key-env", "field.apiKeyEnv", "field.apiKeyEnvPlaceholder", "field.apiKeyEnvHint");

  // The vision switch: a fixed set of values, never free text (the image accepts
  // three). Empty leaves the image's own default (`no`) in place.
  //
  // It sits in its own 视觉 section, NOT in the advanced drawer: image input is a
  // subject, so it must not be buried among the image's shm / seccomp / passthrough
  // needs. The local side uses the same section name to report what setup wrote.
  const visionInput = make("select", { id: `${p}vision` });
  const visionField = make("label", {
    class: "field",
    children: [i18nSpan("field.vision"), visionInput, i18nHint("field.visionHint")],
  });
  const visionSection = make("div", { class: "cf-section cf-section-vision", attrs: { role: "group" } });
  visionSection.replaceChildren(visionField);

  function rebuildVisionOptions() {
    const current = visionInput.value;
    const options = [make("option", { value: "", text: t("field.visionPlaceholder") })];
    for (const value of VISION_OPTIONS) options.push(make("option", { value, text: value }));
    visionInput.replaceChildren(...options);
    visionInput.value = VISION_OPTIONS.includes(current) ? current : "";
  }

  const apiKeyField = createApiKeyField(null, { idPrefix: p, apiKeySource });

  // ── list fields (add / remove rows) ───────────────────────────────────

  const lists = {};

  function listField(key, idKey, labelKey, placeholderKey, hintKey) {
    const rows = make("div", { class: "cf-list" });
    const add = make("button", {
      class: "btn small cf-list-add",
      type: "button",
      attrs: { "data-i18n": "field.listAdd" },
    });
    const field = make("div", {
      class: "field cf-list-field",
      children: [i18nSpan(labelKey), rows, add, i18nHint(hintKey)],
    });

    function addRow(value = "") {
      if (rows.childElementCount >= MAX_LIST) return;
      const input = make("input", {
        type: "text",
        attrs: {
          autocomplete: "off",
          spellcheck: "false",
          "data-i18n-placeholder": placeholderKey,
        },
      });
      input.value = value;
      // Keep the first row addressable by a stable id (tests / debugging).
      if (!rows.querySelector(`#${p}${idKey}`)) input.id = `${p}${idKey}`;
      input.disabled = readOnly;
      const remove = make("button", {
        class: "btn small cf-list-remove",
        type: "button",
        text: "×",
        attrs: { "data-i18n-aria-label": "field.listRemove" },
      });
      remove.disabled = readOnly;
      remove.addEventListener("click", () => {
        // Never leave the row container empty: clearing the last row is the way
        // to say "no entries", and a blank row keeps the field discoverable.
        if (rows.childElementCount <= 1) {
          input.value = "";
          return;
        }
        row.remove();
      });
      const row = make("div", { class: "cf-list-row", children: [input, remove] });
      rows.append(row);
    }

    add.addEventListener("click", () => {
      addRow("");
      const inputs = rows.querySelectorAll("input");
      const last = inputs[inputs.length - 1];
      if (last) last.focus();
    });

    function setValues(values) {
      rows.replaceChildren();
      const list = Array.isArray(values) ? values : [];
      const effective = list.length ? list : [""];
      for (const value of effective) addRow(String(value ?? ""));
    }

    function readValues() {
      const out = [];
      for (const input of rows.querySelectorAll("input")) {
        const s = input.value.trim();
        if (s && !out.includes(s)) out.push(s);
      }
      return out;
    }

    // Seed one blank row so a list field is never a bare label: the row is what
    // teaches the `a:b` shape, and readValues() ignores it while empty.
    addRow("");

    lists[key] = { field, rows, add, addRow, setValues, readValues, idKey };
    return field;
  }

  const volumeBinds = listField("VolumeBinds", "volume-binds", "field.volumeBinds", "field.volumeBindsPlaceholder", "field.volumeBindsHint");
  const portBinds = listField("PortBinds", "port-binds", "field.portBinds", "field.portBindsPlaceholder", "field.portBindsHint");
  const environment = listField("environment", "environment", "field.envVars", "field.envVarsPlaceholder", "field.envVarsHint");
  const ulimits = listField("ulimits", "ulimits", "field.ulimits", "field.ulimitsPlaceholder", "field.ulimitsHint");
  const securityOpt = listField("security_opt", "security-opt", "field.securityOpt", "field.securityOptPlaceholder", "field.securityOptHint");

  // ── deploy directory + the resolved compose file ──────────────────────

  const deployDir = pathField("deploy-dir", "field.deployDir", "field.deployDirPlaceholder", "field.deployDirHint");

  const deployPath = make("code", { class: "cf-deploy-path", id: `${p}deploy-path`, text: "—" });
  const deployActions = make("div", { class: "field-inline" });
  const openButton = openDir
    ? make("button", { class: "btn small cf-open-dir", type: "button", attrs: { "data-i18n": "field.openDir" } })
    : null;
  const copyButton = copyText
    ? make("button", { class: "btn small cf-copy-path", type: "button", attrs: { "data-i18n": "field.copyPath" } })
    : null;
  if (openButton) {
    openButton.addEventListener("click", () => {
      const path = deployPath.dataset.path || "";
      if (path) openDir(path);
    });
    deployActions.append(openButton);
  }
  if (copyButton) {
    copyButton.addEventListener("click", () => {
      const path = deployPath.dataset.path || "";
      if (path) copyText(path);
    });
    deployActions.append(copyButton);
  }
  const deployBox = make("div", {
    class: "field cf-deploy",
    children: [
      make("div", {
        class: "cf-deploy-line",
        children: [i18nSpan("field.composeFile"), deployPath, deployActions],
      }),
      // The compose directory is the basis for any relative host path; say so
      // where the user can see it.
      i18nHint("field.pathBasisHint"),
    ],
  });

  // `input` (typing) is coalesced so a burst of keystrokes cannot hammer the
  // route; `change` means the value is committed (blur, or a picker choice), so
  // it resolves at once — the line can never be left showing an older answer.
  deployDir.input.addEventListener("input", () => refreshDeployPath());
  deployDir.input.addEventListener("change", () => refreshDeployPath({ immediate: true }));

  let deployTimer = null;
  function refreshDeployPath({ immediate = false } = {}) {
    if (deployTimer) clearTimeout(deployTimer);
    deployTimer = null;
    if (immediate) probeDeployPath();
    else deployTimer = setTimeout(probeDeployPath, 300);
  }

  async function probeDeployPath() {
    if (!api) {
      deployBox.hidden = true;
      return;
    }
    deployBox.hidden = false;
    const token = ++deployToken;
    try {
      const res = await api("profiles/compose-path", {
        method: "POST",
        body: JSON.stringify({
          id: profileId(),
          containerName: containerNameOf(),
          DeployDir: deployDir.input.value.trim(),
        }),
      });
      if (token !== deployToken) return;
      const file = String(res?.file || res?.deployDir || "").trim();
      deployPath.textContent = file || "—";
      deployPath.dataset.path = file;
    } catch (e) {
      if (token !== deployToken) return;
      deployPath.textContent = t("field.composeFileError");
      deployPath.dataset.path = "";
    }
  }

  // ── assembly ──────────────────────────────────────────────────────────

  // The two common fields, then the 视觉 section, then the advanced group. The
  // divide is "does a normal deployment need to touch this?" — see ADVANCED_KEYS
  // below; the advanced group is collapsed by default but its inputs stay in the
  // DOM, so collapsing never affects what a save submits.
  const advancedPanel = make("div", { class: "cf-adv-panel" });
  advancedPanel.hidden = true;

  const advTitle = i18nSpan("field.advanced", "cf-adv-title");
  const advCount = make("span", { class: "cf-adv-count" });
  advCount.hidden = true;
  const advState = make("span", { class: "cf-adv-state" });
  // A VIEW control: it stays usable in the read-only drawer so the advanced
  // values can still be inspected while the service runs.
  const advToggle = make("button", {
    class: "btn small cf-adv-toggle",
    type: "button",
    attrs: { "aria-expanded": "false" },
    children: [advTitle, advCount, advState],
  });

  advancedPanel.replaceChildren(
    engineBindPort.field,
    volumeBinds,
    portBinds,
    environment,
    ulimits,
    securityOpt,
    shmSize.field,
    apiKeyEnv.field,
    apiKeyField.field,
  );

  host.classList.add("cf-fields");
  host.replaceChildren(
    // The compose directory comes FIRST: it is the root of the deployment — the
    // compose file, the relative-path basis and the project's home — an identity
    // field, on the same level as the container name above it, not a trailing
    // afterthought.
    deployDir.field,
    deployBox,
    gpuModelField,
    // The preset prompt is a sibling block, not inside the label (its buttons
    // are a block action, and interactive content inside a label is ambiguous).
    ...(presetBox ? [presetBox] : []),
    gpuIdsField,
    modelDir.field,
    modelsBindDir.field,
    enginePort.field,
    // 视觉 is its own section, right after the deployment's identity and hardware
    // choices: it is a subject (image input) and a normal choice, not an
    // advanced one. Placed before the drawer so a collapsed drawer never hides it.
    visionSection,
    advToggle,
    advancedPanel,
  );

  // ── the advanced group ───────────────────────────────────────────────
  //
  // The split is "would a normal deployment ever need to change this?". The
  // fields above are the deployment's identity and hardware choices; the ones in
  // ADVANCED_KEYS exist for community images and special situations (they carry
  // an image's shm / seccomp / memlock needs, a passthrough list, …). Kept as
  // data so the badge, the tests and the panel cannot drift.
  const ADVANCED_KEYS = [
    "EngineBindPort",
    "VolumeBinds",
    "PortBinds",
    "environment",
    "ulimits",
    "security_opt",
    "ShmSize",
    "ApiKeyEnv",
    "apiKey",
  ];

  let advancedOpen = false;

  // How many advanced fields carry a value — a preset fills several, and a
  // collapsed group must not hide that silently.
  function advancedSetCount() {
    const body = collect();
    let n = 0;
    for (const key of ADVANCED_KEYS) {
      const value = body[key];
      // "Set" means a real value: an empty string, an empty list, or a port of 0
      // ("auto") all count as unset.
      const isSet = Array.isArray(value)
        ? value.length > 0
        : typeof value === "number"
          ? value > 0
          : String(value ?? "").trim() !== "";
      if (isSet) n += 1;
    }
    return n;
  }

  function updateAdvancedChrome() {
    advState.textContent = t(advancedOpen ? "field.advancedHide" : "field.advancedShow");
    const n = advancedSetCount();
    advCount.hidden = n === 0;
    advCount.textContent = n ? tp("field.advancedSet", { n }) : "";
  }

  // Collapsing only hides the panel; its inputs stay in the DOM, so a save
  // submits their values either way.
  function setAdvancedOpen(open) {
    advancedOpen = !!open;
    advancedPanel.hidden = !advancedOpen;
    advToggle.setAttribute("aria-expanded", advancedOpen ? "true" : "false");
    updateAdvancedChrome();
  }

  advToggle.addEventListener("click", () => setAdvancedOpen(!advancedOpen));
  // Keep the badge and the key-source line honest while the group is edited
  // (input bubbles up from any field inside the panel).
  advancedPanel.addEventListener("input", () => {
    updateAdvancedChrome();
  });
  advancedPanel.addEventListener("change", () => {
    updateAdvancedChrome();
  });

  function modelLabel(entry) {
    const key = `gpuModel.${entry.key}`;
    const localized = t(key);
    return localized === key ? entry.label || entry.key : localized;
  }

  function rebuildOptions() {
    const current = gpuModel.value;
    const seen = new Set([""]);
    const options = [make("option", { value: "", text: t("field.gpuModelPlaceholder") })];
    for (const entry of catalog) {
      if (!entry || !entry.key || seen.has(entry.key)) continue;
      seen.add(entry.key);
      options.push(make("option", { value: entry.key, text: modelLabel(entry) }));
    }
    if (current && !seen.has(current)) options.push(make("option", { value: current, text: current }));
    gpuModel.replaceChildren(...options);
    gpuModel.value = current;
  }

  function setSelectValue(value) {
    const wanted = String(value ?? "");
    if (wanted && ![...gpuModel.options].some((o) => o.value === wanted)) {
      gpuModel.append(make("option", { value: wanted, text: wanted }));
    }
    gpuModel.value = wanted;
  }

  function render(profile) {
    const src = profile && typeof profile === "object" ? profile : {};
    setSelectValue(src.GpuModel || "");
    gpuIds.value = src.GpuIds || "";
    modelDir.input.value = src.ModelDir || "";
    modelsBindDir.input.value = src.ModelsBindDir || "";
    enginePort.input.value = src.EnginePort ? String(src.EnginePort) : "";
    engineBindPort.input.value = src.EngineBindPort ? String(src.EngineBindPort) : "";
    lists.VolumeBinds.setValues(src.VolumeBinds);
    lists.PortBinds.setValues(src.PortBinds);
    lists.environment.setValues(src.environment);
    lists.ulimits.setValues(src.ulimits);
    lists.security_opt.setValues(src.security_opt);
    shmSize.input.value = src.ShmSize || "";
    apiKeyEnv.input.value = src.ApiKeyEnv || "";
    visionInput.value = VISION_OPTIONS.includes(String(src.Vision || "").trim()) ? String(src.Vision).trim() : "";
    // May be the mask the backend returned; it round-trips as "unchanged".
    apiKeyField.render(src.apiKey || "");
    deployDir.input.value = src.DeployDir || "";
    // Carry the keys the form does not own so a round-trip never drops them.
    carried = {};
    for (const [key, value] of Object.entries(src)) {
      if (OWNED_KEYS.has(key) || PAGE_OWNED_SKIP.has(key)) continue;
      carried[key] = Array.isArray(value) ? value.slice() : value;
    }
    // Each open starts collapsed (the default), with the badge telling the user
    // how many advanced fields a profile (or a preset) already carries.
    setAdvancedOpen(false);
    applyVendorSplit();
    applyI18n(host);
    refreshDeployPath({ immediate: true });
  }

  function collect() {
    return {
      ...carried,
      GpuModel: gpuModel.value.trim(),
      // The card picker is authoritative, and only NVIDIA has one: emitting an
      // empty value for every other vendor is what clears a stale selection in
      // storage too.
      GpuIds: vendorOf(gpuModel.value) === NVIDIA ? gpuIds.value.trim() : "",
      ModelDir: modelDir.input.value.trim(),
      ModelsBindDir: modelsBindDir.input.value.trim(),
      EnginePort: numOr0(enginePort.input.value),
      EngineBindPort: numOr0(engineBindPort.input.value),
      VolumeBinds: lists.VolumeBinds.readValues(),
      PortBinds: lists.PortBinds.readValues(),
      environment: lists.environment.readValues(),
      ulimits: lists.ulimits.readValues(),
      security_opt: lists.security_opt.readValues(),
      ShmSize: shmSize.input.value.trim(),
      ApiKeyEnv: apiKeyEnv.input.value.trim(),
      Vision: visionInput.value.trim(),
      // The mask round-trips untouched: the save route reads it as "unchanged".
      apiKey: apiKeyField.value(),
      DeployDir: deployDir.input.value.trim(),
    };
  }

  // Write only the keys a preset supplies, never blanking the rest.
  function applyPreset(patch = {}) {
    if (!patch || typeof patch !== "object") return;
    if (patch.GpuModel !== undefined) setSelectValue(String(patch.GpuModel));
    if (patch.GpuIds !== undefined) gpuIds.value = String(patch.GpuIds);
    if (patch.ModelDir !== undefined) modelDir.input.value = String(patch.ModelDir);
    if (patch.ModelsBindDir !== undefined) modelsBindDir.input.value = String(patch.ModelsBindDir);
    if (patch.EnginePort !== undefined) enginePort.input.value = patch.EnginePort ? String(patch.EnginePort) : "";
    if (patch.EngineBindPort !== undefined) engineBindPort.input.value = patch.EngineBindPort ? String(patch.EngineBindPort) : "";
    if (patch.VolumeBinds !== undefined) lists.VolumeBinds.setValues(patch.VolumeBinds);
    if (patch.PortBinds !== undefined) lists.PortBinds.setValues(patch.PortBinds);
    if (patch.environment !== undefined) lists.environment.setValues(patch.environment);
    if (patch.ulimits !== undefined) lists.ulimits.setValues(patch.ulimits);
    if (patch.security_opt !== undefined) lists.security_opt.setValues(patch.security_opt);
    if (patch.ShmSize !== undefined) shmSize.input.value = String(patch.ShmSize);
    if (patch.ApiKeyEnv !== undefined) apiKeyEnv.input.value = String(patch.ApiKeyEnv);
    if (patch.Vision !== undefined) visionInput.value = VISION_OPTIONS.includes(String(patch.Vision)) ? String(patch.Vision) : "";
    if (patch.apiKey !== undefined) apiKeyField.render(patch.apiKey);
    if (patch.DeployDir !== undefined) deployDir.input.value = String(patch.DeployDir);
    applyVendorSplit();
    updateAdvancedChrome();
    refreshDeployPath({ immediate: true });
  }

  function setReadOnly(flag) {
    readOnly = !!flag;
    for (const node of host.querySelectorAll("input, select, button")) {
      // The group toggle is a VIEW control: it stays usable so the advanced
      // values can still be read while the service runs.
      if (node.classList && node.classList.contains("cf-adv-toggle")) continue;
      node.disabled = readOnly;
    }
  }

  function relocalize() {
    rebuildOptions();
    rebuildVisionOptions();
    applyI18n(host);
    applyVendorSplit();
    updateAdvancedChrome();
    apiKeyField.relocalize();
  }

  function setCatalog(models) {
    catalog = Array.isArray(models) ? models : [];
    rebuildOptions();
    rebuildVisionOptions();
    applyVendorSplit();
  }

  function gpuModelValue() {
    return gpuModel.value.trim();
  }

  return {
    host,
    refs: {
      gpuModel,
      gpuIds,
      gpuIdsField,
      amdNote,
      preset: presetBox,
      presetText: presetBox ? presetBox.querySelector(`#${p}preset-text`) : null,
      presetApply: presetBox ? presetBox.querySelector(`#${p}preset-apply`) : null,
      presetIgnore: presetBox ? presetBox.querySelector(`#${p}preset-ignore`) : null,
      modelDir: modelDir.input,
      modelsBindDir: modelsBindDir.input,
      enginePort: enginePort.input,
      engineBindPort: engineBindPort.input,
      volumeBinds: lists.VolumeBinds,
      portBinds: lists.PortBinds,
      environment: lists.environment,
      ulimits: lists.ulimits,
      securityOpt: lists.security_opt,
      shmSize: shmSize.input,
      apiKeyEnv: apiKeyEnv.input,
      vision: visionInput,
      apiKey: apiKeyField.refs.input,
      apiKeySource: apiKeyField.refs.source,
      deployDir: deployDir.input,
      deployPath,
      deployBox,
      openButton,
      copyButton,
      advancedPanel,
      advancedToggle: advToggle,
      advancedState: advState,
      advancedCount: advCount,
    },
    setCatalog,
    setReadOnly,
    setAdvancedOpen,
    advancedSetCount,
    refreshApiKeySource: () => apiKeyField.refreshSource(),
    render,
    collect,
    applyPreset,
    relocalize,
    refreshDeployPath,
    gpuModelValue,
  };
}

export default { createContainerFields, createApiKeyField, createVisionStatus, gpuVendorOf, gpuIdsApplies };
