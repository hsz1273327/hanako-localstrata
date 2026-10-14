// lib/imagepull.js — background `docker pull` job for the settings page.
//
// Pulling an image can take minutes (tens of GB), so it always runs in the
// background as a module-level singleton and the page polls GET /images/pull.
// `spawn` is used instead of `spawnSync` so the AppHost event loop never
// blocks; no timeout is applied for the same reason.
//
// Mirrors lib/firstrun.js's state / idleState() shape (one in-flight job per
// App instance, reset between tests).
import { spawn } from "node:child_process";
import { resolveDockerPath } from "./docker.js";

// Keep the state payload small: only the last few meaningful lines are shown.
const MAX_TAIL = 8;
const MAX_LINE = 500;

// Same shape the docker tags accept: registry/repo:tag@digest, no spaces.
const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]{0,255}$/;

function idleState() {
  return {
    running: false,
    image: "",
    ok: null,
    error: null,
    tail: [],
    startedAt: null,
    finishedAt: null,
  };
}

let state = idleState();

// Return a copy so callers can never mutate the live job state.
export function getImagePullState() {
  return { ...state, tail: [...state.tail] };
}

export function resetImagePullState() {
  state = idleState();
  return getImagePullState();
}

function pushLine(line) {
  const text = String(line || "").replace(/\r$/, "");
  if (!text.trim()) return;
  state.tail.push(text.slice(0, MAX_LINE));
  if (state.tail.length > MAX_TAIL) state.tail.shift();
}

function fail(error) {
  state = { ...state, running: false, ok: false, error, finishedAt: Date.now() };
}

// Start a pull unless one is already running. Throws for an invalid image name
// or a missing docker binary; the route turns those into HTTP 400.
export async function beginImagePull(ctx, image, opts = {}) {
  const name = String(image || "").trim();
  if (!IMAGE_RE.test(name)) throw new Error("镜像名不合法");
  if (state.running) {
    return { started: false, already: true, state: getImagePullState() };
  }

  const bin = opts.dockerBin || (await resolveDockerPath(ctx));
  if (!bin) throw new Error("未找到 docker 命令，无法拉取镜像");

  const spawnFn = opts.spawn || spawn;
  state = { ...idleState(), running: true, image: name, startedAt: Date.now() };

  let child;
  try {
    child = spawnFn(bin, ["pull", name], { windowsHide: true });
  } catch (err) {
    fail(String(err?.message || err));
    throw err;
  }

  const consume = (chunk) => {
    for (const line of String(chunk).split("\n")) pushLine(line);
  };
  child.stdout?.on("data", consume);
  child.stderr?.on("data", consume);
  child.on("error", (err) => fail(String(err?.message || err)));
  child.on("close", (code) => {
    const ok = code === 0;
    if (ok) {
      state = { ...state, running: false, ok: true, error: null, finishedAt: Date.now() };
      return;
    }
    const last = state.tail.length ? state.tail[state.tail.length - 1] : "";
    fail(last || `docker pull ${name} 失败（退出码 ${code}）`);
  });

  return { started: true, state: getImagePullState() };
}
