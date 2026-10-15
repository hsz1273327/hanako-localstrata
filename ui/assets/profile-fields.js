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

  // The key CONTENT (ApiKeyEnv above names the address it is injected into). A
  // secret: masked on the way in, and a returned mask means "unchanged".
  function secretField(key, labelKey, placeholderKey, hintKey) {
    const input = make("input", {
      id: `${p}${key}`,
      type: "password",
      attrs: { autocomplete: "off", spellcheck: "false", "data-i18n-placeholder": placeholderKey },
    });
    const source = make("p", { class: "field-hint cf-key-source" });
    const field = make("label", {
      class: "field",
      children: [i18nSpan(labelKey), input, source, i18nHint(hintKey)],
    });
    return { field, input, source };
  }

  const apiKeyField = secretField("api-key", "field.apiKey", "field.apiKeyPlaceholder", "field.apiKeyHint");

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

  // The two common fields, then the advanced group. The divide is "does a
  // normal deployment need to touch this?" — see ADVANCED_KEYS below; the
  // advanced group is collapsed by default but its inputs stay in the DOM, so
  // collapsing never affects what a save submits.
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

  // "Where does the effective key come from?" — the profile's own override wins;
  // otherwise the global key, then (local only) the selected config file, whose
  // name the page supplies. Only a file name ever reaches here, never a value.
  function updateApiKeySource() {
    const override = apiKeyField.input.value.trim() !== "";
    let text;
    if (override) {
      text = t("field.apiKeySourceOverride");
    } else {
      const src = typeof apiKeySource === "function" ? apiKeySource() : null;
      const file = src && src.file ? String(src.file) : "";
      text = file ? tp("field.apiKeySourceConfig", { file }) : t("field.apiKeySourceGlobal");
    }
    apiKeyField.source.textContent = text;
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
    updateApiKeySource();
  });
  advancedPanel.addEventListener("change", () => {
    updateAdvancedChrome();
    updateApiKeySource();
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
    // May be the mask the backend returned; it round-trips as "unchanged".
    apiKeyField.input.value = src.apiKey || "";
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
    updateApiKeySource();
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
      // The mask round-trips untouched: the save route reads it as "unchanged".
      apiKey: apiKeyField.input.value.trim(),
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
    if (patch.apiKey !== undefined) apiKeyField.input.value = String(patch.apiKey);
    if (patch.DeployDir !== undefined) deployDir.input.value = String(patch.DeployDir);
    applyVendorSplit();
    updateAdvancedChrome();
    updateApiKeySource();
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
    applyI18n(host);
    applyVendorSplit();
    updateAdvancedChrome();
    updateApiKeySource();
  }

  function setCatalog(models) {
    catalog = Array.isArray(models) ? models : [];
    rebuildOptions();
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
      apiKey: apiKeyField.input,
      apiKeySource: apiKeyField.source,
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
    refreshApiKeySource: updateApiKeySource,
    render,
    collect,
    applyPreset,
    relocalize,
    refreshDeployPath,
    gpuModelValue,
  };
}

export default { createContainerFields, gpuVendorOf, gpuIdsApplies };
