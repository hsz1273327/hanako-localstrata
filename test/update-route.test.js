// Route-level test for the /update deploy-mode forwarding.
//
// Local mode must keep the source pipeline (we only assert it is not taken when
// the stored mode is docker). Docker mode must hand off to DockerDeployer.update
// and report progress through the same GET /update contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import registerUpdateRoutes from "../routes/update.js";

function makeCtx(values) {
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
    network: { fetch: async () => ({ ok: false }) },
    log: { info() {}, warn() {}, error() {} },
  };
}

function register() {
  const routes = { post: {}, get: {} };
  const app = {
    post(route, handler) {
      routes.post[route] = handler;
    },
    get(route, handler) {
      routes.get[route] = handler;
    },
  };
  return { routes, app };
}

function fakeC() {
  return {
    req: { json: async () => ({}) },
    json(body, status = 200) {
      return { status, body };
    },
  };
}

test("update route: docker mode forwards to DockerDeployer.update", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX shell stub only");
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strata-src-"));
  fs.writeFileSync(path.join(dir, "Dockerfile"), "FROM scratch\n");
  const containerJson = JSON.stringify({
    Id: "0123456789abcdef",
    Name: "/strata",
    Config: { Image: "strata:latest", Env: ["MODEL=IQ3_S", "PORT=8080", "CONFIG=/data/config/strata-iq3_s.json"] },
    State: { Running: true, Status: "running", ExitCode: 0 },
    HostConfig: { Binds: ["strata-data:/data"], PortBindings: {}, RestartPolicy: { Name: "unless-stopped" } },
    NetworkSettings: { Ports: {} },
  });
  const imageJson = JSON.stringify([{ Id: "sha256:abc", RepoTags: ["strata:latest"], Created: "2024-01-01T00:00:00Z" }]);
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "strata-docker-stub-"));
  const bin = path.join(binDir, "docker");
  fs.writeFileSync(
    bin,
    `#!/bin/sh\ncase "$1" in\n  inspect) printf '%s' '${containerJson}' ;;\n  image) printf '%s' '${imageJson}' ;;\n  *) : ;;\nesac\nexit 0\n`,
  );
  fs.chmodSync(bin, 0o755);

  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath}`;

  const { routes, app } = register();
  const ctx = makeCtx({
    deployMode: "docker",
    containerName: "strata",
    imageName: "strata",
    imageNames: ["strata"],
    volumeName: "strata-data",
    strataDir: dir,
    dockerStopTimeoutSec: 1,
  });
  registerUpdateRoutes(app, ctx);

  try {
    const started = await routes.post["/update"](fakeC());
    assert.equal(started.body.running, true);
    assert.deepEqual(started.body.steps, ["重建镜像", "重建容器"]);

    // Poll the progress endpoint until the async update finishes.
    let state = null;
    for (let i = 0; i < 100; i++) {
      state = routes.get["/update"](fakeC()).body;
      if (state.error || state.done) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(!state.error, `docker update failed: ${state.error}`);
    assert.equal(state.done, true);
    assert.ok(fs.existsSync(path.join(dir, "strata-update.log")));
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});
