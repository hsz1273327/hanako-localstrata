// lib/docker.js — thin wrapper around the `docker` CLI.
//
// Everything here shells out to an external command (allowed by
// `app/process.spawn`), because the v2 AppHost blocks bare `child_process`.
// The wrapper is intentionally dumb: it knows how to find `docker` and how to
// run subcommands, nothing about Strata. lib/deployer/docker.js holds the
// Strata semantics.
import { spawnSync } from "node:child_process";
import { commandExists } from "./process.js";

export const DOCKER_CANDIDATES = ["docker", "/usr/bin/docker", "/usr/local/bin/docker"];

// Resolve the docker executable. Prefer the host-side resolver (it returns the
// real path after symlink resolution and is the documented way to locate an
// external binary), then fall back to a PATH lookup via commandExists. Returns
// null when docker is not installed/visible.
export async function resolveDockerPath(ctx) {
  try {
    const resolved = await ctx?.process?.resolveExecutable?.({ candidates: DOCKER_CANDIDATES });
    if (resolved?.path) return resolved.path;
  } catch {
    /* fall through to PATH lookup */
  }
  for (const candidate of DOCKER_CANDIDATES) {
    const found = commandExists(candidate);
    if (found) return found;
  }
  return null;
}

const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

// Run a docker subcommand synchronously. Never throws: callers get
// `{ ok, stdout, stderr, status, error }` and decide whether a failure is
// fatal. `input` is passed on stdin (used by `docker exec -i`).
export function runDocker(bin, args, { input, timeout, maxBuffer = DEFAULT_MAX_BUFFER, cwd } = {}) {
  const res = spawnSync(bin, args, {
    encoding: "utf8",
    input,
    timeout,
    maxBuffer,
    cwd,
    windowsHide: true,
  });
  return {
    ok: res.status === 0 && !res.error,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
    status: res.status,
    error: res.error || null,
  };
}

// Adapter object used by the docker deployer. Exposing the individual
// subcommands (instead of free-form `run`) keeps the deployer readable and
// makes it trivial to stub in unit tests.
export function createDockerAdapter(bin) {
  const run = (args, opts) => runDocker(bin, args, opts);

  return {
    bin,
    available: () => !!bin,
    raw: run,

    // `docker inspect <name>` → first object, or null when it does not exist.
    // `--type container` is essential: without it `docker inspect <name>` happily
    // returns an *image* of the same name, which would masquerade as a running
    // container (seen in the wild when only `strata:latest` exists).
    inspect(name, opts = {}) {
      const res = run(["inspect", "--type", "container", name], { ...opts, timeout: opts.timeout ?? 10000 });
      if (!res.ok) return null;
      try {
        const data = JSON.parse(res.stdout);
        const first = Array.isArray(data) ? data[0] : data;
        if (!first || !first.State) return null;
        return first;
      } catch {
        return null;
      }
    },

    env(name) {
      const info = this.inspect(name);
      const out = {};
      for (const entry of info?.Config?.Env || []) {
        const i = String(entry).indexOf("=");
        if (i > 0) out[entry.slice(0, i)] = entry.slice(i + 1);
      }
      return out;
    },

    // `docker image inspect` → first object, or null when the image is not
    // present. This is the deployment anchor in 1.1.0: the first-run default
    // is docker when any configured image exists, independent of containers.
    imageInspect(name) {
      const res = run(["image", "inspect", name], { timeout: 10000 });
      if (!res.ok) return null;
      try {
        const data = JSON.parse(res.stdout);
        const first = Array.isArray(data) ? data[0] : data;
        return first && typeof first === "object" ? first : null;
      } catch {
        return null;
      }
    },

    imageExists(name) {
      return !!this.imageInspect(name);
    },

    start(name) {
      return run(["start", name], { timeout: 60000 });
    },

    stop(name, timeoutSec = 60) {
      return run(["stop", "-t", String(timeoutSec), name], { timeout: (timeoutSec + 30) * 1000 });
    },

    restart(name, timeoutSec = 60) {
      return run(["restart", "-t", String(timeoutSec), name], { timeout: (timeoutSec + 30) * 1000 });
    },

    logs(name, tail = 200) {
      const res = run(["logs", "--tail", String(tail), name], { timeout: 20000 });
      return `${res.stdout}${res.stderr}`;
    },

    // `docker exec` returning stdout; throws with stderr on failure.
    exec(name, argv, opts = {}) {
      const args = ["exec"];
      if (opts.input !== undefined || opts.interactive) args.push("-i");
      args.push(name, ...argv);
      const res = run(args, { timeout: opts.timeout ?? 20000, input: opts.input });
      if (!res.ok) {
        const detail = (res.stderr || res.stdout || res.error?.message || "").trim();
        const err = new Error(`docker exec ${argv.join(" ")} 失败${detail ? `: ${detail}` : ""}`);
        err.code = res.status;
        throw err;
      }
      return res.stdout;
    },

    // `docker exec` returning the raw result instead of throwing.
    execRaw(name, argv, opts = {}) {
      const args = ["exec"];
      if (opts.input !== undefined || opts.interactive) args.push("-i");
      args.push(name, ...argv);
      return run(args, { timeout: opts.timeout ?? 20000, input: opts.input });
    },

    // Read a file without requiring the container to be running (unlike
    // `docker exec`). `docker cp <name>:<path> -` streams the file to stdout;
    // returns null when the file/container is missing. Used as a fallback for
    // reading the config of a stopped container.
    catFile(name, filePath) {
      const res = run(["cp", `${name}:${filePath}`, "-"], { timeout: 30000 });
      if (!res.ok) return null;
      return res.stdout;
    },

    cp(src, dest) {
      return run(["cp", src, dest], { timeout: 60000 });
    },

    build(image, dir, extra = []) {
      return run(["build", "-t", image, ...extra, dir], { timeout: undefined });
    },
  };
}
