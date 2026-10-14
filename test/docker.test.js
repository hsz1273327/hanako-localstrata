// Unit tests for the docker deployer. External `docker` is stubbed with an
// in-memory adapter, mirroring the repo's "stub the external tool" style.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  envMap,
  containerTag,
  containerConfigPath,
  containerPort,
  publishedHostPort,
  containerPublishesPort,
  deriveDockerPort,
  summarizeContainer,
  sampleRunParams,
  buildRunArgs,
  dataVolumeFromRunParams,
  createDockerDeployer,
} from "../lib/deployer/docker.js";
import { resolveDeployMode } from "../lib/deployer/index.js";
import { resolveDockerPath, createDockerAdapter } from "../lib/docker.js";
import { getStatus, startService, stopService, applyConfigEdits, switchDeployMode as switchService } from "../lib/strata.js";

const MAIN_CONFIG = "/data/config/strata-iq3_s.json";
const SHARED_CONFIG = "/data/config/strata-iq3_s.shared-settings.json";
const MAIN_TEXT = JSON.stringify({
  args: ["--max-context", "32768", "--kv", "int8"],
  port: 8080,
  host: "0.0.0.0",
  sampling: { temperature: 0.7 },
});
const SHARED_TEXT = JSON.stringify({ max_tokens: 4096 });

function baseInfo(overrides = {}) {
  return {
    Id: "0123456789abcdef0123456789abcdef",
    Name: "/strata",
    Config: {
      Image: "strata:latest",
      Env: [
        "MODEL=IQ3_S",
        "FAMILY=qwen",
        "PORT=8080",
        "HOST=0.0.0.0",
        `CONFIG=${MAIN_CONFIG}`,
        "API_KEY=sk-strata-test",
      ],
    },
    State: { Running: true, Status: "running", ExitCode: 0, StartedAt: "2024-01-01T00:00:00Z" },
    HostConfig: {
      Binds: ["strata-data:/data"],
      PortBindings: { "8080/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }] },
      RestartPolicy: { Name: "unless-stopped" },
      DeviceRequests: [{ Driver: "nvidia", Count: -1, Capabilities: [["gpu"]] }],
      Ulimits: [{ Name: "memlock", Soft: -1, Hard: -1 }],
      IpcMode: "private",
      ShmSize: 67108864,
    },
    NetworkSettings: { Ports: { "8080/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }] } },
    ...overrides,
  };
}

function imageInfo(name = "strata:latest") {
  return { Id: "sha256:abc", RepoTags: [name], Created: "2024-01-01T00:00:00Z" };
}

function fakeAdapter({ info = baseInfo(), files = {}, engineText = "", logsText = "", image = imageInfo() } = {}) {
  const calls = [];
  return {
    calls,
    info,
    image,
    inspect() {
      calls.push(["inspect"]);
      return info;
    },
    imageInspect(name) {
      calls.push(["imageInspect", name]);
      return image;
    },
    imageExists(name) {
      calls.push(["imageExists", name]);
      return !!image;
    },
    start(name) {
      calls.push(["start", name]);
      return { ok: true, stdout: name, stderr: "" };
    },
    stop(name, timeoutSec) {
      calls.push(["stop", name, timeoutSec]);
      return { ok: true, stdout: name, stderr: "" };
    },
    restart(name, timeoutSec) {
      calls.push(["restart", name, timeoutSec]);
      return { ok: true, stdout: name, stderr: "" };
    },
    logs(name, tail) {
      calls.push(["logs", name, tail]);
      return logsText;
    },
    exec(name, argv) {
      calls.push(["exec", name, ...argv]);
      if (argv[0] === "cat") {
        const p = argv[1];
        if (p in files) return files[p];
        throw new Error(`cat: ${p}: No such file`);
      }
      if (argv[0] === "tail") return engineText;
      if (argv[0] === "cp") return "";
      throw new Error(`unexpected exec: ${argv.join(" ")}`);
    },
    execRaw(name, argv) {
      calls.push(["execRaw", name, ...argv]);
      return { ok: true, stdout: "", stderr: "" };
    },
    catFile(name, filePath) {
      calls.push(["catFile", name, filePath]);
      return filePath in files ? files[filePath] : null;
    },
    cp(src, dest) {
      calls.push(["cp", src, dest]);
      return { ok: true, stdout: "", stderr: "" };
    },
    build(image, dir, extra = []) {
      calls.push(["build", image, dir, ...extra]);
      return { ok: true, stdout: "", stderr: "" };
    },
    compose(file, args) {
      calls.push(["compose", file, ...args]);
      return { ok: true, stdout: "", stderr: "" };
    },
    raw(args) {
      calls.push(["raw", ...args]);
      return { ok: true, stdout: "", stderr: "" };
    },
  };
}

function makeCtx(values = {}, { http } = {}) {
  return {
    config: {
      values,
      async get(key) {
        return values[key];
      },
      async set(key, value) {
        values[key] = value;
      },
      async setMany(patch) {
        Object.assign(values, patch);
      },
    },
    network: {
      fetch: async (url, init) => {
        const href = typeof url === "string" ? url : url?.url || String(url);
        if (http && href.includes("/v1/status")) return http(url, init);
        return { ok: false, status: 404, json: async () => ({}) };
      },
    },
    log: { info() {}, warn() {}, error() {} },
  };
}

function okStatus(body) {
  return { ok: true, status: 200, json: async () => body };
}

const dockerCfg = {
  deployMode: "docker",
  containerName: "strata",
  imageName: "strata",
  dockerStopTimeoutSec: 60,
};

// ── Pure helpers ──────────────────────────────────────────────────────────

test("envMap / containerTag / containerConfigPath mirror docker-entrypoint.sh", () => {
  const info = baseInfo();
  const env = envMap(info);
  assert.equal(env.MODEL, "IQ3_S");
  assert.equal(containerTag(env), "iq3_s");
  assert.equal(containerTag({ FAMILY: "swift", MODEL: "Q2_0" }), "swift-q2_0");
  assert.equal(containerConfigPath(env), MAIN_CONFIG);
  assert.equal(
    containerConfigPath({ STRATA_DATA: "/volume", FAMILY: "qwen", MODEL: "IQ2_XS" }),
    "/volume/config/strata-iq2_xs.json",
  );
  assert.equal(containerConfigPath({ CONFIG: "/data/config/custom.json" }), "/data/config/custom.json");
  assert.equal(containerPort({}), 8080);
  assert.equal(containerPort({ PORT: "9000" }), 9000);
});

test("publishedHostPort / containerPublishesPort / deriveDockerPort", () => {
  const info = baseInfo({
    NetworkSettings: { Ports: { "8080/tcp": [{ HostIp: "0.0.0.0", HostPort: "9090" }] } },
  });
  assert.equal(publishedHostPort(info, 8080), 9090);
  assert.equal(containerPublishesPort(info, 8080), true);
  assert.equal(containerPublishesPort(info, 8081), false);
  // plugin override wins, then the published host port, then the container port
  assert.equal(deriveDockerPort({ port: 1234 }, info), 1234);
  assert.equal(deriveDockerPort({ port: 0 }, info), 9090);
  assert.equal(deriveDockerPort({ port: 0 }, baseInfo({ NetworkSettings: { Ports: {} } })), 8080);
});

test("summarizeContainer reports state and image", () => {
  const summary = summarizeContainer(baseInfo(), "strata");
  assert.equal(summary.running, true);
  assert.equal(summary.state, "running");
  assert.equal(summary.image, "strata:latest");
  assert.equal(summary.containerName, "strata");
  assert.equal(summarizeContainer(null, "strata").state, "missing");
});

test("sampleRunParams / buildRunArgs round-trip the important flags", () => {
  const params = sampleRunParams(
    baseInfo({
      NetworkSettings: { Ports: { "8080/tcp": [{ HostIp: "0.0.0.0", HostPort: "9090" }] } },
      HostConfig: {
        Binds: ["strata-data:/data", "/models:/gguf"],
        PortBindings: { "8080/tcp": [{ HostIp: "0.0.0.0", HostPort: "9090" }] },
        RestartPolicy: { Name: "unless-stopped" },
        DeviceRequests: [{ Driver: "nvidia", Count: -1, Capabilities: [["gpu"]] }],
        Ulimits: [{ Name: "memlock", Soft: -1, Hard: -1 }],
        IpcMode: "private",
        ShmSize: 67108864,
      },
    }),
    "strata",
  );
  assert.equal(params.gpus, "all");
  assert.equal(dataVolumeFromRunParams(params), "strata-data");
  const args = buildRunArgs("strata", params);
  assert.deepEqual(args, [
    "run", "-d", "--name", "strata",
    "--restart", "unless-stopped",
    "--gpus", "all",
    "-v", "strata-data:/data",
    "-v", "/models:/gguf",
    "-p", "9090:8080",
    "-e", "MODEL=IQ3_S",
    "-e", "FAMILY=qwen",
    "-e", "PORT=8080",
    "-e", "HOST=0.0.0.0",
    "-e", `CONFIG=${MAIN_CONFIG}`,
    "-e", "API_KEY=sk-strata-test",
    "--ulimit", "memlock=-1:-1",
    "--ipc", "private",
    "--shm-size", "67108864",
    "strata:latest",
  ]);
});

// ── Deployer behaviour (fake adapter) ─────────────────────────────────────

test("docker getStatus: running container with HTTP → running", async () => {
  const docker = fakeAdapter({ files: { [MAIN_CONFIG]: MAIN_TEXT, [SHARED_CONFIG]: SHARED_TEXT } });
  const ctx = makeCtx({ ...dockerCfg }, { http: () => okStatus({ engine: "0.1.38", service: "strata" }) });
  const status = await getStatus(ctx, { docker, platform: "linux" });
  assert.equal(status.state, "running");
  assert.equal(status.deployMode, "docker");
  assert.equal(status.port, 8080);
  assert.equal(status.configFile, "strata-iq3_s.json");
  assert.equal(status.version.local, "0.1.38");
  assert.equal(status.docker.containerName, "strata");
  assert.equal(status.docker.image, "strata:latest");
  assert.equal(status.configSummary.context, 32768);
});

test("docker getStatus: running container without HTTP → starting", async () => {
  const docker = fakeAdapter({ files: { [MAIN_CONFIG]: MAIN_TEXT } });
  const ctx = makeCtx({ ...dockerCfg });
  const status = await getStatus(ctx, { docker, platform: "linux" });
  assert.equal(status.state, "starting");
});

test("docker getStatus: stopped container → stopped with exit code", async () => {
  const info = baseInfo({ State: { Running: false, Status: "exited", ExitCode: 137 } });
  const docker = fakeAdapter({ info, files: { [MAIN_CONFIG]: MAIN_TEXT } });
  const ctx = makeCtx({ ...dockerCfg });
  const status = await getStatus(ctx, { docker, platform: "linux" });
  assert.equal(status.state, "stopped");
  assert.equal(status.docker.exitCode, 137);
});

test("docker getStatus: stopped container config is read via docker cp fallback", async () => {
  const info = baseInfo({ State: { Running: false, Status: "exited", ExitCode: 0 } });
  const docker = fakeAdapter({ info, files: { [MAIN_CONFIG]: MAIN_TEXT } });
  // `docker exec` is unavailable while stopped; the cp fallback must kick in.
  docker.exec = () => {
    throw new Error("container is not running");
  };
  const status = await getStatus(makeCtx({ ...dockerCfg }), { docker, platform: "linux" });
  assert.equal(status.state, "stopped");
  assert.equal(status.configSummary.context, 32768);
  assert.ok(docker.calls.some((c) => c[0] === "catFile"));
});

test("docker getStatus: missing container but image present → stopped", async () => {
  const docker = fakeAdapter({ info: null });
  const ctx = makeCtx({ ...dockerCfg });
  const status = await getStatus(ctx, { docker, platform: "linux" });
  assert.equal(status.state, "stopped");
  assert.equal(status.docker.state, "missing");
  assert.equal(status.imageVersion.tag, "strata:latest");
});

test("docker getStatus: missing container and image → not-installed", async () => {
  const docker = fakeAdapter({ info: null, image: null });
  const ctx = makeCtx({ ...dockerCfg });
  const status = await getStatus(ctx, { docker, platform: "linux" });
  assert.equal(status.state, "not-installed");
  assert.equal(status.docker.state, "missing");
});

test("docker start: already running is a no-op", async () => {
  const docker = fakeAdapter({ files: { [MAIN_CONFIG]: MAIN_TEXT } });
  const ctx = makeCtx({ ...dockerCfg }, { http: () => okStatus({ engine: "1.0.0" }) });
  const existing = await startService(ctx, { docker, platform: "linux" });
  assert.equal(existing.started, false);
  assert.equal(existing.already, true);
});

test("docker start: creates the container from run params when it is missing", async () => {
  const missing = fakeAdapter({ info: null });
  const ctx = makeCtx(
    { ...dockerCfg, volumeName: "strata-data" },
    { http: () => okStatus({ engine: "1.0.0" }) },
  );
  const started = await startService(ctx, { docker: missing, platform: "linux" });
  assert.equal(started.started, true);
  assert.equal(started.created, true);
  const runCall = missing.calls.find((c) => c[0] === "raw" && c[1] === "run");
  assert.ok(runCall, "expected docker run");
  assert.ok(runCall.includes("--gpus") && runCall.includes("all"));
  assert.ok(runCall.includes("strata-data:/data"));
  assert.ok(ctx.config.values.dockerRunConfig, "run params should be persisted");
});

test("docker start without an image is refused", async () => {
  const missing = fakeAdapter({ info: null, image: null });
  const refused = await startService(makeCtx({ ...dockerCfg }), { docker: missing, platform: "linux" });
  assert.equal(refused.started, false);
  assert.equal(refused.state, "not-installed");
  assert.ok(!missing.calls.some((c) => c[0] === "raw" && c[1] === "run"));
});

test("docker stop uses the configured grace period", async () => {
  const docker = fakeAdapter({ files: { [MAIN_CONFIG]: MAIN_TEXT } });
  const result = await stopService(makeCtx({ ...dockerCfg }), { docker, platform: "linux" });
  assert.equal(result.stopped, true);
  const stopCall = docker.calls.find((c) => c[0] === "stop");
  assert.deepEqual(stopCall, ["stop", "strata", 60]);
});

test("docker writeConfig edits the volume json and rejects port", async () => {
  const docker = fakeAdapter({ files: { [MAIN_CONFIG]: MAIN_TEXT, [SHARED_CONFIG]: SHARED_TEXT } });
  const ctx = makeCtx({ ...dockerCfg });
  const result = await applyConfigEdits(ctx, { context: 65536 }, { docker, platform: "linux" });
  assert.equal(result.saved, true);
  assert.equal(result.restartRequired, true);
  assert.deepEqual(result.diff.map((d) => d.key), ["context"]);
  assert.ok(docker.calls.some((c) => c[0] === "execRaw" && c[2] === "cp"));
  assert.ok(docker.calls.some((c) => c[0] === "cp"));

  await assert.rejects(
    () => applyConfigEdits(makeCtx({ ...dockerCfg }), { port: 9000 }, { docker, platform: "linux" }),
    /未知字段: port/,
  );
});

test("docker readLogs parses metrics from the container log file", async () => {
  const docker = fakeAdapter({
    files: { [MAIN_CONFIG]: MAIN_TEXT },
    engineText: "read in 100 ms (10.0 tok/s)\ngenerated in 200 ms (5.5 tok/s)\n",
  });
  const { createDockerDeployer: factory } = await import("../lib/deployer/docker.js");
  const deployer = factory({ ctx: makeCtx({ ...dockerCfg }), cfg: { ...dockerCfg }, docker, info: docker.info });
  const log = await deployer.readLogs(10);
  assert.equal(log.metrics.pp, 10);
  assert.equal(log.metrics.tg, 5.5);
  assert.ok(log.lines.length >= 2);
});

test("docker update rebuilds the image and recreates the container", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strata-src-"));
  fs.writeFileSync(path.join(dir, "Dockerfile"), "FROM scratch\n");
  const docker = fakeAdapter({ files: { [MAIN_CONFIG]: MAIN_TEXT } });
  const { createDockerDeployer: factory } = await import("../lib/deployer/docker.js");
  const deployer = factory({
    ctx: makeCtx({ ...dockerCfg, strataDir: dir }),
    cfg: { ...dockerCfg, strataDir: dir },
    docker,
    info: docker.info,
  });
  const result = await deployer.update("v1.2.3");
  assert.equal(result.done, true);
  assert.equal(result.method, "build+recreate");
  assert.ok(docker.calls.some((c) => c[0] === "build"));
  assert.ok(docker.calls.some((c) => c[0] === "raw" && c[1] === "rename"));
  assert.ok(docker.calls.some((c) => c[0] === "raw" && c[1] === "run"));
});

test("docker recreate honors the configured volume", async () => {
  const docker = fakeAdapter({ files: { [MAIN_CONFIG]: MAIN_TEXT } });
  const { createDockerDeployer: factory } = await import("../lib/deployer/docker.js");
  const cfg = { ...dockerCfg, volumeName: "my-vol" };
  const deployer = factory({ ctx: makeCtx(cfg), cfg, docker, info: docker.info });
  await deployer.update("v1");
  const runCall = docker.calls.find((c) => c[0] === "raw" && c[1] === "run");
  assert.ok(runCall.includes("my-vol:/data"));
});

test("docker update recreates without a build when no source dir is set", async () => {
  const docker = fakeAdapter({ files: { [MAIN_CONFIG]: MAIN_TEXT } });
  const { createDockerDeployer: factory } = await import("../lib/deployer/docker.js");
  const deployer = factory({
    ctx: makeCtx({ ...dockerCfg }),
    cfg: { ...dockerCfg },
    docker,
    info: docker.info,
  });
  const result = await deployer.update("v1.2.3");
  assert.equal(result.method, "recreate");
  assert.ok(!docker.calls.some((c) => c[0] === "build"));
  assert.ok(docker.calls.some((c) => c[0] === "raw" && c[1] === "run"));
});

// ── Detection ─────────────────────────────────────────────────────────────

test("first-run detection picks docker when an anchor image exists (image only)", async () => {
  const docker = fakeAdapter({ info: null });
  const values = { containerName: "strata", imageNames: ["strata"] };
  const ctx = makeCtx(values);
  const mode = await resolveDeployMode(ctx, values, { docker, platform: "linux" });
  assert.equal(mode.mode, "docker");
  assert.equal(mode.source, "auto-default");
  // The default is persisted so later calls are explicit and never switch.
  assert.equal(ctx.config.values.deployMode, "docker");
});

test("first-run detection falls back to local without an image", async () => {
  const docker = fakeAdapter({ image: null });
  const values = { containerName: "strata", imageNames: ["strata"] };
  const ctx = makeCtx(values);
  const mode = await resolveDeployMode(ctx, values, { docker, platform: "linux" });
  assert.equal(mode.mode, "local");
  assert.equal(mode.source, "auto-default");
  assert.equal(ctx.config.values.deployMode, "local");
});

test("detection never switches once the user has chosen (no auto)", async () => {
  const docker = fakeAdapter({ image: imageInfo() });
  const values = { deployMode: "local", containerName: "strata" };
  const ctx = makeCtx(values);
  const mode = await resolveDeployMode(ctx, values, { docker, platform: "linux" });
  assert.equal(mode.mode, "local");
  assert.equal(mode.source, "explicit");
  assert.equal(ctx.config.values.deployMode, "local");
});

test("explicit docker ignores the published-port check", async () => {
  const info = baseInfo({ NetworkSettings: { Ports: {} } });
  const docker = fakeAdapter({ info });
  const values = { deployMode: "docker", containerName: "strata" };
  const ctx = makeCtx(values);
  const mode = await resolveDeployMode(ctx, values, { docker, platform: "linux" });
  assert.equal(mode.mode, "docker");
  assert.equal(mode.source, "explicit");
});

test("win32 never resolves to docker even when explicitly set", async () => {
  const values = { deployMode: "docker", containerName: "strata" };
  const ctx = makeCtx(values);
  const mode = await resolveDeployMode(ctx, values, { docker: fakeAdapter(), platform: "win32" });
  assert.equal(mode.mode, "local");
  assert.equal(mode.source, "platform");
  assert.equal(ctx.config.values.deployMode, "local");
});

test("switching modes stops the running deployment first", async () => {
  const docker = fakeAdapter({ files: { [MAIN_CONFIG]: MAIN_TEXT } });
  const ctx = makeCtx({ ...dockerCfg }, { http: () => okStatus({ engine: "1.0.0" }) });
  const result = await switchService(ctx, "local", { strataDir: "/srv/Strata" }, { docker, platform: "linux" });
  assert.equal(result.switched, true);
  assert.equal(result.deployMode, "local");
  assert.ok(result.stopped && result.stopped.stopped === true);
  assert.ok(docker.calls.some((c) => c[0] === "stop"));
  assert.equal(ctx.config.values.deployMode, "local");
});

test("switching to docker is rejected on win32", async () => {
  const ctx = makeCtx({ deployMode: "local" });
  await assert.rejects(
    () => switchService(ctx, "docker", {}, { docker: fakeAdapter(), platform: "win32" }),
    /仅支持 Linux/,
  );
});

test("explicit docker without a docker CLI reports not-installed instead of throwing", async () => {
  const values = { deployMode: "docker", containerName: "strata" };
  const status = await getStatus(makeCtx(values), { docker: null, platform: "linux" });
  assert.equal(status.state, "not-installed");
  assert.equal(status.deployMode, "docker");
  assert.equal(status.docker.cli, false);
  assert.match(status.error, /docker/);
});

test("win32 status advertises local-only and never touches docker", async () => {
  const values = { deployMode: "docker", containerName: "strata" };
  const docker = fakeAdapter();
  const status = await getStatus(makeCtx(values), { docker, platform: "win32" });
  assert.equal(status.deployMode, "local");
  assert.deepEqual(status.supportedDeployModes, ["local"]);
});

// ── lib/docker.js: real wrapper against a fake `docker` executable ────────

test("lib/docker.js resolves and drives a fake docker executable", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX shell stub only");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strata-docker-stub-"));
  const bin = path.join(dir, "docker");
  const inspectJson = JSON.stringify(baseInfo());
  fs.writeFileSync(
    bin,
    `#!/bin/sh\nif [ "$1" = "inspect" ]; then printf '%s' '${inspectJson}'; exit 0; fi\nif [ "$1" = "logs" ]; then echo "server stdout"; exit 0; fi\nexit 1\n`,
  );
  fs.chmodSync(bin, 0o755);

  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${oldPath}`;
  try {
    const resolved = await resolveDockerPath(makeCtx({}));
    assert.equal(resolved, bin);
    const adapter = createDockerAdapter(resolved);
    const info = adapter.inspect("strata");
    assert.equal(info.Config.Image, "strata:latest");
    assert.equal(adapter.env("strata").MODEL, "IQ3_S");
    assert.equal(adapter.logs("strata", 5), "server stdout\n");
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("lib/docker.js does not mistake an image for a container", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX shell stub only");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strata-docker-image-"));
  const bin = path.join(dir, "docker");
  // An image object: has Config but no State/HostConfig. `docker inspect`
  // without --type returns this shape when only strata:latest exists.
  const imageJson = JSON.stringify({ Id: "sha256:abc", RepoTags: ["strata:latest"], Config: { Env: [] } });
  fs.writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "inspect" ]; then printf '%s' '${imageJson}'; exit 0; fi\nexit 1\n`);
  fs.chmodSync(bin, 0o755);

  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${oldPath}`;
  try {
    const adapter = createDockerAdapter(bin);
    assert.equal(adapter.inspect("strata"), null);
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
