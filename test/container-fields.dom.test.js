// Behavioural coverage for ui/assets/profile-fields.js without jsdom.
//
// The repo is dependency-free by design, so instead of pulling jsdom in we run
// the real module against a tiny DOM stub. It is intentionally minimal: just the
// handful of DOM calls the module makes (create/append/replaceChildren, a class
// list, attribute → dataset, a `select` whose `.value` is set explicitly, and a
// descendant query for the selectors the module uses). That is enough to drive
// the two things a source guard cannot prove — the GPU vendor split and the
// add/remove list rows — through their real code paths.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createContainerFields, createApiKeyField, createVisionStatus } from "../ui/assets/profile-fields.js";
import registerSettingsRoutes, { saveProfile } from "../routes/settings.js";
import { readAllConfig } from "../lib/strata.js";
import { mi50Preset } from "../lib/mi50.js";
import { t } from "../ui/assets/i18n.js";

// ── minimal DOM ───────────────────────────────────────────────────────────

function matchesSimple(node, sel) {
  if (sel.startsWith("#")) return node.id === sel.slice(1);
  if (sel.startsWith(".")) return node.className.split(/\s+/).includes(sel.slice(1));
  if (sel.startsWith("[")) {
    const name = sel.slice(1, -1).split("=")[0];
    return Object.prototype.hasOwnProperty.call(node.attrs, name);
  }
  return node.tagName === sel.toUpperCase();
}

function installDom() {
  class Node {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = [];
      this.parent = null;
      this.attrs = {};
      this.dataset = {};
      this.listeners = {};
      this._text = "";
      this.className = "";
      this.id = "";
      this.value = "";
      this.placeholder = "";
      this.hidden = false;
      this.disabled = false;
      this.type = "";
      this.title = "";
      this.lang = "";
      this.classList = {
        add: (c) => {
          const set = new Set(this.className.split(/\s+/).filter(Boolean));
          set.add(c);
          this.className = [...set].join(" ");
        },
        remove: (c) => {
          this.className = this.className.split(/\s+/).filter((x) => x && x !== c).join(" ");
        },
        contains: (c) => this.className.split(/\s+/).includes(c),
      };
    }
    get textContent() {
      return this._text + this.children.map((c) => c.textContent).join("");
    }
    set textContent(v) {
      for (const c of this.children) c.parent = null;
      this.children = [];
      this._text = String(v);
    }
    get options() {
      return this.children.filter((c) => c.tagName === "OPTION");
    }
    setAttribute(name, value) {
      this.attrs[name] = String(value);
      if (name === "id") this.id = String(value);
      if (name === "class") this.className = String(value);
      if (name === "hidden") this.hidden = true;
      if (name.startsWith("data-")) {
        const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        this.dataset[key] = String(value);
      }
    }
    getAttribute(name) {
      return this.attrs[name];
    }
    append(...nodes) {
      for (const n of nodes) {
        if (n === undefined || n === null) continue;
        n.parent = this;
        this.children.push(n);
      }
    }
    replaceChildren(...nodes) {
      for (const c of this.children) c.parent = null;
      this.children = [];
      this._text = "";
      this.append(...nodes);
    }
    remove() {
      if (!this.parent) return;
      const i = this.parent.children.indexOf(this);
      if (i >= 0) this.parent.children.splice(i, 1);
      this.parent = null;
    }
    addEventListener(type, fn) {
      (this.listeners[type] || (this.listeners[type] = [])).push(fn);
    }
    dispatch(type) {
      for (const fn of this.listeners[type] || []) fn({ target: this, preventDefault() {} });
    }
    dispatchEvent(ev) {
      // The module emits a native `change` after a picker choice; route it into
      // the same listener map so the stub exercises the real path.
      this.dispatch(ev && ev.type ? ev.type : String(ev));
      return true;
    }
    get childElementCount() {
      return this.children.length;
    }
    _walk() {
      const out = [];
      const rec = (n) => {
        for (const c of n.children) {
          out.push(c);
          rec(c);
        }
      };
      rec(this);
      return out;
    }
    querySelectorAll(sel) {
      const parts = String(sel).split(",").map((s) => s.trim()).filter(Boolean);
      return this._walk().filter((n) => parts.some((p) => matchesSimple(n, p)));
    }
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    }
  }

  const document = {
    documentElement: new Node("html"),
    title: "",
    createElement: (tag) => new Node(tag),
  };
  const prev = globalThis.document;
  globalThis.document = document;
  return { restore: () => { globalThis.document = prev; } };
}

// ── tests ─────────────────────────────────────────────────────────────────

const CATALOG = [
  { key: "nvidia", label: "NVIDIA GeForce RTX (CUDA)", vendor: "nvidia", gfx: null },
  { key: "amd-mi50", label: "AMD Instinct MI50 (Vega 20, gfx906)", vendor: "amd", gfx: "gfx906" },
  { key: "amd-7900xtx", label: "AMD Radeon RX 7900 XT / XTX (RDNA3, gfx1100)", vendor: "amd", gfx: "gfx1100" },
];

// The card-model picker is built from the catalog (never a free-text field), and
// the per-card control follows the vendor: shown for NVIDIA, hidden AND cleared
// for AMD.
test("the card picker renders the catalog and the vendor split works end to end", () => {
  const dom = installDom();
  try {
    const host = document.createElement("div");
    const ctr = createContainerFields(host, { idPrefix: "t-" });
    ctr.setCatalog(CATALOG);

    // Options: the blank "choose" entry + the catalog, localized or verbatim.
    assert.equal(ctr.refs.gpuModel.options.length, 1 + CATALOG.length);

    ctr.render({ GpuModel: "nvidia", GpuIds: "0,1" });
    assert.equal(ctr.refs.gpuIdsField.hidden, false, "NVIDIA shows the per-card field");
    assert.equal(ctr.refs.gpuIds.value, "0,1");

    // Switching to an AMD card hides it AND clears the residual value.
    ctr.refs.gpuModel.value = "amd-mi50";
    ctr.refs.gpuModel.dispatch("change");
    assert.equal(ctr.refs.gpuIdsField.hidden, true, "AMD hides the per-card field");
    assert.equal(ctr.refs.gpuIds.value, "", "the stale card selection is cleared");
    assert.equal(ctr.collect().GpuIds, "", "collect() never emits GpuIds for AMD");
    assert.equal(ctr.collect().GpuModel, "amd-mi50");

    // ...and back to NVIDIA starts empty, not with the old value.
    ctr.refs.gpuModel.value = "nvidia";
    ctr.refs.gpuModel.dispatch("change");
    assert.equal(ctr.refs.gpuIdsField.hidden, false);
    assert.equal(ctr.refs.gpuIds.value, "");
    ctr.refs.gpuIds.value = "0";
    assert.equal(ctr.collect().GpuIds, "0");
  } finally {
    dom.restore();
  }
});

// ① The compose directory is the ROOT of the deployment (the compose file's
// home, the relative-path basis, the project's location), so it leads the block
// — an identity field beside the container name, not a trailing afterthought.
test("the compose directory leads the container block", () => {
  const dom = installDom();
  try {
    const host = document.createElement("div");
    const ctr = createContainerFields(host, { idPrefix: "t-", preset: true });
    ctr.setCatalog(CATALOG);
    const deployLabel = ctr.refs.deployDir.parent;
    assert.equal(host.children[0], deployLabel, "the deploy field is the first child");
    assert.equal(host.children[1], ctr.refs.deployBox, "its resolved-path line follows it");
    const gpuLabel = ctr.refs.gpuModel.parent;
    assert.ok(host.children.indexOf(gpuLabel) > host.children.indexOf(deployLabel), "the card model comes after");
  } finally {
    dom.restore();
  }
});

// ── the compose path preview follows the directory input ──────────────────

// A tiny backend stand-in: it resolves exactly the way the route does (a
// non-empty DeployDir wins; empty falls back to the per-container folder) and
// records every probe so the calls themselves can be asserted.
function previewBackend() {
  const calls = [];
  const api = async (p, init) => {
    assert.equal(p, "profiles/compose-path");
    const body = JSON.parse(init.body);
    calls.push(body);
    const deployDir = String(body.DeployDir || "").trim() || `/home/u/.hanako-localstrata/${body.containerName || "strata"}`;
    return { deployDir, file: `${deployDir}/docker-compose.yml` };
  };
  return { calls, api };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("typing into the compose directory re-resolves the line (debounced)", async () => {
  const dom = installDom();
  try {
    const { calls, api } = previewBackend();
    const host = document.createElement("div");
    const ctr = createContainerFields(host, { idPrefix: "t-", api, containerName: () => "strata" });
    ctr.setCatalog(CATALOG);
    ctr.render({ containerName: "strata" });
    await sleep(30);
    assert.equal(ctr.refs.deployPath.dataset.path, "/home/u/.hanako-localstrata/strata/docker-compose.yml");

    // A keystroke must NOT fire a probe straight away…
    ctr.refs.deployDir.value = "/data/strata-docker";
    ctr.refs.deployDir.dispatch("input");
    await sleep(60);
    assert.equal(calls.length, 1, "a keystroke is coalesced, not sent immediately");
    assert.equal(ctr.refs.deployPath.dataset.path, "/home/u/.hanako-localstrata/strata/docker-compose.yml");

    // …but the line catches up once the debounce elapses.
    await sleep(300);
    assert.equal(ctr.refs.deployPath.dataset.path, "/data/strata-docker/docker-compose.yml");
    assert.equal(calls[calls.length - 1].DeployDir, "/data/strata-docker");
  } finally {
    dom.restore();
  }
});

test("a committed change resolves at once", async () => {
  const dom = installDom();
  try {
    const { calls, api } = previewBackend();
    const host = document.createElement("div");
    const ctr = createContainerFields(host, { idPrefix: "t-", api, containerName: () => "strata" });
    ctr.setCatalog(CATALOG);
    ctr.render({ containerName: "strata" });
    await sleep(30);

    ctr.refs.deployDir.value = "/data/strata-docker";
    ctr.refs.deployDir.dispatch("change");
    await sleep(60);
    // Well inside the 300ms debounce: a `change` is a commit, resolved now.
    assert.equal(ctr.refs.deployPath.dataset.path, "/data/strata-docker/docker-compose.yml");
    assert.equal(calls.length, 2);
  } finally {
    dom.restore();
  }
});

// The directory picker writes the value programmatically (no event of its own),
// which is exactly how the line used to get stuck on the default.
test("choosing a directory with the picker also updates the line", async () => {
  const dom = installDom();
  try {
    const { calls, api } = previewBackend();
    const pickPath = async (input) => {
      input.value = "/data/strata-docker";
    };
    const host = document.createElement("div");
    const ctr = createContainerFields(host, { idPrefix: "t-", api, pickPath, containerName: () => "strata" });
    ctr.setCatalog(CATALOG);
    ctr.render({ containerName: "strata" });
    await sleep(30);

    const pick = host.querySelectorAll("button").find((b) => b.className.includes("cf-pick"));
    assert.ok(pick, "the deploy field carries a picker button");
    pick.dispatch("click");
    await sleep(60);
    assert.equal(ctr.refs.deployDir.value, "/data/strata-docker");
    assert.equal(ctr.refs.deployPath.dataset.path, "/data/strata-docker/docker-compose.yml");
    assert.equal(calls[calls.length - 1].DeployDir, "/data/strata-docker");
  } finally {
    dom.restore();
  }
});

// The two actions target whatever the line currently shows, not a value baked in
// at open time.
test("the open/copy actions follow the resolved path", async () => {
  const dom = installDom();
  try {
    const { api } = previewBackend();
    const opened = [];
    const copied = [];
    const host = document.createElement("div");
    const ctr = createContainerFields(host, {
      idPrefix: "t-",
      api,
      containerName: () => "strata",
      openDir: (path) => opened.push(path),
      copyText: (text) => copied.push(text),
    });
    ctr.setCatalog(CATALOG);
    ctr.render({ containerName: "strata" });
    await sleep(30);

    ctr.refs.deployDir.value = "/data/strata-docker";
    ctr.refs.deployDir.dispatch("change");
    await sleep(60);

    ctr.refs.openButton.dispatch("click");
    ctr.refs.copyButton.dispatch("click");
    assert.deepEqual(opened, ["/data/strata-docker/docker-compose.yml"]);
    assert.deepEqual(copied, ["/data/strata-docker/docker-compose.yml"]);
  } finally {
    dom.restore();
  }
});

// The preview line and the file the save actually writes must be the same path:
// both go through resolveDeployDir / composeFilePath (the route and the writer
// share one source), so a change in the field can never make them disagree.
test("the previewed compose path is exactly the file the save writes", async () => {
  const dom = installDom();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strata-preview-"));
  const handlers = {};
  const app = { get: (p, h) => { handlers[p] = h; }, post: (p, h) => { handlers[p] = h; } };
  const ctx = makeCtx({});
  registerSettingsRoutes(app, ctx);
  const api = async (p, init) => {
    // The page calls without a leading slash (the SDK adds the route prefix);
    // the registered handler map is keyed with it.
    const handler = handlers[p.startsWith("/") ? p : `/${p}`];
    assert.equal(typeof handler, "function", `no route for ${p}`);
    const res = await handler({ req: { json: async () => JSON.parse(init.body) }, json: (data) => ({ data }) });
    return res.data;
  };
  try {
    const host = document.createElement("div");
    const ctr = createContainerFields(host, { idPrefix: "t-", api, containerName: () => "mybox", profileId: () => "" });
    ctr.setCatalog(CATALOG);
    ctr.render({ containerName: "mybox", GpuModel: "nvidia" });
    // The user points the deployment at their own directory and commits it.
    ctr.refs.deployDir.value = dir;
    ctr.refs.deployDir.dispatch("change");
    await sleep(60);

    const saved = await saveProfile(ctx, {
      name: "mybox",
      type: "container",
      imageName: "strata",
      imageTag: "latest",
      containerName: "mybox",
      ...ctr.collect(),
    });
    assert.equal(ctr.refs.deployPath.dataset.path, path.join(dir, "docker-compose.yml"));
    assert.equal(saved.compose.file, ctr.refs.deployPath.dataset.path, "preview and real write must agree");
    assert.ok(fs.existsSync(saved.compose.file), "the file is really there");
  } finally {
    dom.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── the advanced group (collapsed by default) ─────────────────────────────

// Walk the stub's parent links: is `node` inside the advanced panel?
function inAdvancedPanel(ctr, node) {
  for (let n = node; n; n = n.parent) {
    if (n === ctr.refs.advancedPanel) return true;
  }
  return false;
}

// ── 视觉 has its own section (image input is a subject) ────────────────────

test("the container's vision switch sits in its own section, outside the drawer", () => {
  const dom = installDom();
  try {
    const host = document.createElement("div");
    const ctr = createContainerFields(host, { idPrefix: "t-" });
    ctr.setCatalog(CATALOG);

    // Not in the advanced drawer: a collapsed drawer must not hide a normal
    // deployment choice.
    assert.equal(inAdvancedPanel(ctr, ctr.refs.vision), false, "not inside the drawer");
    const section = host.children.find((c) => c.classList.contains("cf-section-vision"));
    assert.ok(section, "the section exists in the form");
    let inside = false;
    for (let n = ctr.refs.vision; n; n = n.parent) if (n === section) inside = true;
    assert.equal(inside, true, "the select lives inside the section");
    // …and it stays before the toggle, so it is visible while the drawer is shut.
    assert.ok(
      host.children.indexOf(section) > host.children.indexOf(ctr.refs.enginePort.parent),
      "the section follows the common fields",
    );
    assert.equal(
      host.children.indexOf(section) + 1,
      host.children.indexOf(ctr.refs.advancedToggle),
      "and comes right before the drawer toggle",
    );

    // Setting it is not an advanced value, so it must not count toward the badge.
    ctr.refs.vision.value = "yes";
    assert.equal(ctr.advancedSetCount(), 0, "the vision switch is not an advanced field");
    assert.equal(ctr.refs.advancedCount.hidden, true, "and the badge stays away");
    assert.equal(ctr.collect().Vision, "yes", "while still being submitted");
  } finally {
    dom.restore();
  }
});

test("the local side reports 视觉 in the same section shape, with no control", () => {
  const dom = installDom();
  try {
    const host = document.createElement("div");
    const st = createVisionStatus(host, { idPrefix: "x-" });
    assert.equal(st.field.classList.contains("cf-section-vision"), true, "its own section");
    assert.equal(st.field.classList.contains("cf-readonly-item"), true, "and the shared read-only block style");
    assert.equal(st.field.hidden, true, "hidden until the backend reports");
    assert.equal(st.field.children[0].attrs["data-i18n"], "field.vision", "named 视觉, like the container's");
    assert.equal(st.refs.line.id, "x-vision-status");

    st.render({ available: true, encoder: "gpu", mmproj: "/m/mmproj.gguf" });
    assert.equal(st.field.hidden, false, "shown once there is something to say");
    assert.match(st.refs.line.textContent, /mmproj\.gguf/, "the encoder block is named");
    // The shape follows the semantics: a local install's vision is setup's, so
    // there is nothing to type in here.
    assert.equal(st.field.querySelectorAll("input, select, textarea").length, 0, "no control at all");
    st.render(null);
    assert.equal(st.field.hidden, true, "a container hides the line");
  } finally {
    dom.restore();
  }
});

test("the advanced fields live inside the collapsed group; the common ones stay out", () => {
  const dom = installDom();
  try {
    const host = document.createElement("div");
    const ctr = createContainerFields(host, { idPrefix: "t-" });
    ctr.setCatalog(CATALOG);
    ctr.render({ containerName: "box", GpuModel: "nvidia" });

    // Collapsed by default, and announced as such.
    assert.equal(ctr.refs.advancedPanel.hidden, true, "the group starts collapsed");
    assert.equal(ctr.refs.advancedToggle.getAttribute("aria-expanded"), "false");

    const advanced = {
      EngineBindPort: ctr.refs.engineBindPort,
      VolumeBinds: ctr.refs.volumeBinds.rows,
      PortBinds: ctr.refs.portBinds.rows,
      environment: ctr.refs.environment.rows,
      ulimits: ctr.refs.ulimits.rows,
      security_opt: ctr.refs.securityOpt.rows,
      ShmSize: ctr.refs.shmSize,
      ApiKeyEnv: ctr.refs.apiKeyEnv,
    };
    for (const [key, node] of Object.entries(advanced)) {
      assert.ok(inAdvancedPanel(ctr, node), `${key} must live in the advanced group`);
    }
    // The identity / hardware fields a normal deployment needs stay common.
    for (const node of [
      ctr.refs.deployDir,
      ctr.refs.gpuModel,
      ctr.refs.gpuIds,
      ctr.refs.modelDir,
      ctr.refs.modelsBindDir,
      ctr.refs.enginePort,
    ]) {
      assert.equal(inAdvancedPanel(ctr, node), false, "a common field must not sit inside the advanced group");
    }
    // The toggle comes right after the common fields, with the panel under it.
    const at = host.children.indexOf(ctr.refs.advancedToggle);
    assert.ok(at > host.children.indexOf(ctr.refs.enginePort.parent), "the toggle follows the common fields");
    assert.equal(host.children[at + 1], ctr.refs.advancedPanel);
  } finally {
    dom.restore();
  }
});

test("the group expands and collapses, with localized state copy", () => {
  const dom = installDom();
  try {
    const host = document.createElement("div");
    const ctr = createContainerFields(host, { idPrefix: "t-" });
    ctr.setCatalog(CATALOG);
    ctr.render({ containerName: "box", GpuModel: "nvidia" });
    assert.equal(ctr.refs.advancedState.textContent, t("field.advancedShow"));

    ctr.refs.advancedToggle.dispatch("click");
    assert.equal(ctr.refs.advancedPanel.hidden, false, "the group expands");
    assert.equal(ctr.refs.advancedToggle.getAttribute("aria-expanded"), "true");
    assert.equal(ctr.refs.advancedState.textContent, t("field.advancedHide"));

    ctr.refs.advancedToggle.dispatch("click");
    assert.equal(ctr.refs.advancedPanel.hidden, true, "and collapses again");
    assert.equal(ctr.refs.advancedToggle.getAttribute("aria-expanded"), "false");
  } finally {
    dom.restore();
  }
});

// Collapsing is presentation only: the inputs stay in the DOM, so a save
// submits them — including the batch a community-image preset fills.
test("a collapsed group still submits, and a preset's advanced values are kept", () => {
  const dom = installDom();
  try {
    const host = document.createElement("div");
    const ctr = createContainerFields(host, { idPrefix: "t-", preset: true });
    ctr.setCatalog(CATALOG);
    const preset = mi50Preset({ containerName: "strata-mi50", home: "/home/u" });
    ctr.applyPreset(preset);

    assert.equal(ctr.refs.advancedPanel.hidden, true, "the preset does not force the group open");
    const body = ctr.collect();
    assert.deepEqual(body.VolumeBinds, preset.VolumeBinds);
    assert.deepEqual(body.PortBinds, preset.PortBinds);
    assert.deepEqual(body.environment, preset.environment);
    assert.deepEqual(body.ulimits, preset.ulimits);
    assert.deepEqual(body.security_opt, preset.security_opt);
    assert.equal(body.ShmSize, "16g");
    assert.equal(body.EngineBindPort, 8085);

    // The badge tells the user a collapsed group is not empty (7 of the 8 carry
    // a value; the preset leaves ApiKeyEnv alone).
    assert.equal(ctr.advancedSetCount(), 7);
    assert.equal(ctr.refs.advancedCount.hidden, false);
    assert.match(ctr.refs.advancedCount.textContent, /7/);

    // Editing inside the group updates the badge live.
    ctr.refs.shmSize.value = "";
    ctr.refs.advancedPanel.dispatch("input");
    assert.equal(ctr.advancedSetCount(), 6);
  } finally {
    dom.restore();
  }
});

// The API key field: a secret in the advanced group, plus a line saying which key
// is actually in effect.
test("the API key field is a password input inside the advanced group", () => {
  const dom = installDom();
  try {
    const host = document.createElement("div");
    const ctr = createContainerFields(host, { idPrefix: "t-" });
    ctr.setCatalog(CATALOG);

    // What the backend returns is the MASK; it round-trips as "unchanged".
    ctr.render({ containerName: "box", GpuModel: "nvidia", apiKey: "********" });
    assert.equal(ctr.refs.apiKey.type, "password", "a secret input, never a text field");
    assert.equal(inAdvancedPanel(ctr, ctr.refs.apiKey), true, "the key lives in the advanced group");
    assert.equal(ctr.refs.apiKey.value, "********");
    assert.equal(ctr.collect().apiKey, "********");

    // Empty is an explicit clear; a real value replaces.
    ctr.refs.apiKey.value = "";
    assert.equal(ctr.collect().apiKey, "");
    ctr.refs.apiKey.value = "sk-new";
    assert.equal(ctr.collect().apiKey, "sk-new");

    // The key counts toward the "already set" badge like its neighbours.
    assert.equal(ctr.advancedSetCount(), 1);

    // Read-only locks it (no write path) like every other value field.
    ctr.setReadOnly(true);
    assert.equal(ctr.refs.apiKey.disabled, true);
  } finally {
    dom.restore();
  }
});

test("the key field names the key that is actually in effect", () => {
  const dom = installDom();
  try {
    // A local deployment: the page supplies the selected config file's name.
    const host = document.createElement("div");
    const ctr = createContainerFields(host, {
      idPrefix: "t-",
      apiKeySource: () => ({ file: "strata-a.json", hasKey: true }),
    });
    ctr.setCatalog(CATALOG);
    ctr.render({ containerName: "box", GpuModel: "nvidia" });
    assert.match(ctr.refs.apiKeySource.textContent, /strata-a\.json/, "names the config file the key would come from");

    // An override switches the line to "this profile wins".
    ctr.refs.apiKey.value = "sk-x";
    ctr.refs.apiKey.dispatch("input");
    assert.equal(ctr.refs.apiKeySource.textContent, t("field.apiKeySourceOverride"));

    // Clearing it goes back to the fallback chain.
    ctr.refs.apiKey.value = "";
    ctr.refs.apiKey.dispatch("input");
    assert.match(ctr.refs.apiKeySource.textContent, /strata-a\.json/);

    // Without a config file at all (or a container profile): just the global key.
    const host2 = document.createElement("div");
    const ctr2 = createContainerFields(host2, { idPrefix: "u-", apiKeySource: () => ({ file: "", hasKey: false }) });
    ctr2.setCatalog(CATALOG);
    ctr2.render({ containerName: "box", GpuModel: "nvidia" });
    assert.equal(ctr2.refs.apiKeySource.textContent, t("field.apiKeySourceGlobal"));
  } finally {
    dom.restore();
  }
});

// ── the shared API-key fragment (the LOCAL side mounts it directly) ───────

// Both profile types carry the same override. The container block puts this
// control in its advanced group; a local profile has no such group, so the page
// mounts the SAME fragment into its own host — one implementation, no second
// password-input logic.
test("the shared key fragment mounts standalone (the local side's path)", () => {
  const dom = installDom();
  try {
    const host = document.createElement("div");
    const key = createApiKeyField(host, {
      idPrefix: "pfl-",
      apiKeySource: () => ({ file: "strata-iq3_s.json", hasKey: true }),
    });
    // It mounted itself: a secret input, with its label in the shared copy.
    assert.equal(host.children[0], key.field);
    assert.equal(key.refs.input.type, "password");
    assert.equal(key.refs.input.id, "pfl-api-key");
    key.relocalize();
    assert.equal(key.field.children[0].textContent, t("field.apiKey"), "the label is localized");

    // The local-only third source is visible: the selected config file.
    key.render("");
    assert.match(key.refs.source.textContent, /strata-iq3_s\.json/);

    // Mask round-trip: what the backend returned goes back out unchanged…
    key.render("********");
    assert.equal(key.value(), "********");
    // …an override is reported as an override…
    key.render("sk-own");
    assert.equal(key.value(), "sk-own");
    assert.equal(key.refs.source.textContent, t("field.apiKeySourceOverride"));
    // …and empty means an explicit clear.
    key.render("");
    assert.equal(key.value(), "");

    // Read-only locks the value but keeps the source line readable.
    key.setReadOnly(true);
    assert.equal(key.refs.input.disabled, true);
    assert.ok(key.refs.source.textContent.length > 0);
    key.setReadOnly(false);
    assert.equal(key.refs.input.disabled, false);
  } finally {
    dom.restore();
  }
});

// Without a config file to name (a container profile, or a host that supplied
// none) the line drops the config clause and says "global fallback" only.
test("the fallback wording drops the config-file clause when there is no file", () => {
  const dom = installDom();
  try {
    const host = document.createElement("div");
    const key = createApiKeyField(host, { idPrefix: "x-" }); // no apiKeySource at all
    key.render("");
    assert.equal(key.refs.source.textContent, t("field.apiKeySourceGlobal"));
  } finally {
    dom.restore();
  }
});

// The override state is a STATUS and gets a marker; the other two states read the
// same way but carry no marker (a marker that is always on marks nothing).
test("the override state is marked; the other two states are not", () => {
  const dom = installDom();
  try {
    const host = document.createElement("div");
    const key = createApiKeyField(host, {
      idPrefix: "t-",
      apiKeySource: () => ({ file: "strata-a.json", hasKey: true }),
    });

    // Not overridden (a config file is named) → no marker, muted wording.
    key.render("");
    assert.equal(key.refs.dot.hidden, true, "no marker when nothing is overridden");
    assert.equal(key.refs.source.classList.contains("is-override"), false);
    assert.match(key.refs.source.textContent, /strata-a\.json/);

    // Overridden → the state dot appears and the line takes the amber class.
    key.render("********");
    assert.equal(key.refs.dot.hidden, false, "the override is marked");
    assert.equal(key.refs.source.classList.contains("is-override"), true);
    assert.equal(key.refs.source.textContent, t("field.apiKeySourceOverride"));

    // Not overridden again → the marker goes away.
    key.render("");
    assert.equal(key.refs.dot.hidden, true);
    assert.equal(key.refs.source.classList.contains("is-override"), false);

    // The third state (global only, no config file) also carries no marker.
    const host2 = document.createElement("div");
    const key2 = createApiKeyField(host2, { idPrefix: "u-" });
    key2.render("");
    assert.equal(key2.refs.dot.hidden, true);
    assert.equal(key2.refs.source.textContent, t("field.apiKeySourceGlobal"));
  } finally {
    dom.restore();
  }
});

// A field the form does not render (the template-contributed device rules) is
// preserved through render → collect, so an edit never drops it.
test("collect() preserves the fields the form does not render", () => {
  const dom = installDom();
  try {
    const host = document.createElement("div");
    const ctr = createContainerFields(host, { idPrefix: "t-" });
    ctr.setCatalog(CATALOG);
    ctr.render({
      GpuModel: "nvidia",
      ModelDir: "/models",
      device_cgroup_rules: ["c 226:* rmw"],
      // A page-owned identity field must NOT be echoed by the block.
      imageName: "strata",
      containerName: "strata",
    });
    const body = ctr.collect();
    assert.deepEqual(body.device_cgroup_rules, ["c 226:* rmw"]);
    assert.equal(body.imageName, undefined, "the image identity stays the page's");
    assert.equal(body.containerName, undefined);
    assert.equal(body.ModelDir, "/models");
  } finally {
    dom.restore();
  }
});

// The list fields are add/remove rows and read back as a clean list.
test("the list fields add and remove rows and collect clean values", () => {
  const dom = installDom();
  try {
    const host = document.createElement("div");
    const ctr = createContainerFields(host, { idPrefix: "t-" });
    ctr.setCatalog(CATALOG);

    const volumes = ctr.refs.volumeBinds;
    // An empty list still shows one blank row, so the field is discoverable.
    assert.equal(volumes.rows.childElementCount, 1);

    volumes.setValues(["/mnt/models:/models", "/srv/data:/data:ro"]);
    assert.equal(volumes.rows.childElementCount, 2);
    // A blank row and a duplicate are ignored when reading back.
    volumes.addRow("");
    volumes.addRow("/mnt/models:/models");
    assert.deepEqual(volumes.readValues(), ["/mnt/models:/models", "/srv/data:/data:ro"]);

    // Removing a row is a real removal...
    volumes.setValues(["/mnt/models:/models", "/srv/data:/data:ro"]);
    volumes.rows.children[0].querySelector(".cf-list-remove").dispatch("click");
    assert.deepEqual(volumes.readValues(), ["/srv/data:/data:ro"]);
    assert.equal(volumes.rows.childElementCount, 1);

    // ...but the last row is only cleared, never removed.
    volumes.setValues(["/x:/y"]);
    volumes.rows.children[0].querySelector(".cf-list-remove").dispatch("click");
    assert.equal(volumes.rows.childElementCount, 1);
    assert.deepEqual(volumes.readValues(), []);

    // Lists are independent, and collect() reads each one back clean.
    volumes.setValues(["/a:/b"]);
    ctr.refs.portBinds.setValues(["1:2"]);
    ctr.refs.environment.setValues(["KEY=value", "MODE=fast"]);
    const body = ctr.collect();
    assert.deepEqual(body.VolumeBinds, ["/a:/b"]);
    assert.deepEqual(body.PortBinds, ["1:2"]);
    assert.deepEqual(body.environment, ["KEY=value", "MODE=fast"]);
    assert.deepEqual(body.ulimits, []);
    assert.deepEqual(body.security_opt, []);
  } finally {
    dom.restore();
  }
});

// A preset writes only the keys it supplies; everything visible then reads back
// from the real inputs.
test("applyPreset fills the module's fields and collect() reads them back", () => {
  const dom = installDom();
  try {
    const host = document.createElement("div");
    const ctr = createContainerFields(host, { idPrefix: "t-", preset: true });
    ctr.setCatalog(CATALOG);

    ctr.applyPreset({
      GpuModel: "amd-mi50",
      VolumeBinds: ["/home/u/models:/models", "/home/u/data:/data", "/home/u/work:/work"],
      PortBinds: ["8090:8090"],
      EnginePort: 8085,
      EngineBindPort: 8085,
      environment: ["MODELS_DIR=/models", "DATA_DIR=/data"],
      ulimits: ["memlock=-1"],
      security_opt: ["seccomp=unconfined"],
      ShmSize: "16g",
    });

    const body = ctr.collect();
    assert.equal(body.GpuModel, "amd-mi50");
    assert.equal(body.GpuIds, "", "the MI50 preset never leaves a card selection");
    assert.deepEqual(body.VolumeBinds, ["/home/u/models:/models", "/home/u/data:/data", "/home/u/work:/work"]);
    assert.deepEqual(body.PortBinds, ["8090:8090"]);
    assert.equal(body.EnginePort, 8085);
    assert.equal(body.EngineBindPort, 8085);
    assert.equal(body.ShmSize, "16g");
    assert.deepEqual(body.ulimits, ["memlock=-1"]);
    // The preset box exists on the settings surface (not the panel's).
    assert.ok(ctr.refs.preset);
    assert.ok(ctr.refs.presetApply);
  } finally {
    dom.restore();
  }
});

test("read-only disables every control the module owns, but keeps the group toggle usable", () => {
  const dom = installDom();
  try {
    const host = document.createElement("div");
    const ctr = createContainerFields(host, { idPrefix: "t-", preset: true });
    ctr.setCatalog(CATALOG);
    ctr.render({ GpuModel: "nvidia" });

    ctr.setReadOnly(true);
    const isToggle = (c) => c.classList && c.classList.contains("cf-adv-toggle");
    const controls = host.querySelectorAll("input, select, button");
    assert.ok(controls.length > 5);
    assert.ok(
      controls.filter((c) => !isToggle(c)).every((c) => c.disabled),
      "read-only disables every input/select/button",
    );
    assert.equal(ctr.refs.volumeBinds.add.disabled, true, "the add-row button is locked too");
    // …but the disclosure stays clickable, so a running profile's advanced
    // values remain viewable (it holds no value of its own).
    assert.equal(ctr.refs.advancedToggle.disabled, false, "the group toggle stays usable in the read-only view");

    ctr.setReadOnly(false);
    assert.ok(host.querySelectorAll("input, select, button").every((c) => !c.disabled));
  } finally {
    dom.restore();
  }
});

// ── the whole path: the form's body → the save route → storage → compose ──

function makeCtx(values = {}) {
  const store = { ...values };
  return {
    _store: store,
    config: {
      async get(k) {
        return store[k];
      },
      async set(k, v) {
        store[k] = v;
      },
      async setMany(patch) {
        Object.assign(store, patch);
      },
    },
    network: { fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }) },
    log: { info() {}, warn() {}, error() {} },
  };
}

// The MI50 preset applied through the module must read back into the exact body
// the save route expects, persist the new fields, and land a docker-compose.yml
// that carries the card's device request plus the image's own facts. This is the
// one test that runs the real form → route → storage → compose chain.
test("a container profile built by the form round-trips to storage and compose", async () => {
  const dom = installDom();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strata-uifields-"));
  try {
    const host = document.createElement("div");
    const ctr = createContainerFields(host, { idPrefix: "t-", preset: true });
    ctr.setCatalog(CATALOG);

    const preset = mi50Preset({ containerName: "strata-mi50", home: "/home/tester" });
    // The identity fields are the page's, not the module's; the rest goes in.
    ctr.applyPreset(preset);
    ctr.refs.deployDir.value = dir;

    const body = {
      name: "mi50box",
      type: "container",
      imageName: preset.imageName,
      imageTag: preset.imageTag,
      containerName: "strata-mi50",
      ...ctr.collect(),
    };

    const ctx = makeCtx({});
    // The advanced group is still collapsed at save time — its values must be
    // submitted anyway.
    assert.equal(ctr.refs.advancedPanel.hidden, true, "the advanced group is collapsed when saving");
    const saved = await saveProfile(ctx, body);
    assert.equal(saved.saved, true);
    assert.equal(saved.profile.GpuModel, "amd-mi50");
    assert.equal(saved.profile.GpuIds, "", "AMD never stores a card selection");

    const cfg = await readAllConfig(ctx);
    const stored = cfg.profiles.find((p) => p.id === saved.profile.id);
    assert.equal(stored.GpuModel, "amd-mi50");
    assert.equal(stored.EnginePort, 8085);
    assert.equal(stored.ShmSize, "16g");
    assert.deepEqual(stored.ulimits, ["memlock=-1"]);
    assert.deepEqual(stored.security_opt, ["seccomp=unconfined"]);
    assert.equal(stored.VolumeBinds.length, 3);
    assert.ok(stored.VolumeBinds.every((b) => /:\/\w+$/.test(b)), "each mount is host:container");

    const file = path.join(dir, "docker-compose.yml");
    assert.equal(saved.compose.written, true);
    assert.equal(saved.compose.file, file);
    const yml = fs.readFileSync(file, "utf8");
    // The card's device request comes from the model template, not the form.
    assert.match(yml, /"\/dev\/kfd:\/dev\/kfd"/);
    assert.match(yml, /"\/dev\/dri:\/dev\/dri"/);
    assert.match(yml, /"c 226:\* rmw"/);
    // The image's own facts come from the preset.
    assert.match(yml, /shm_size: "16g"/);
    assert.match(yml, /"8090:8090"/);
    assert.match(yml, /"8085:8085"/);
    assert.match(yml, /MODELS_DIR=\/models/);
    assert.match(yml, /memlock:/);
  } finally {
    dom.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
