import { setHostMode, restartService } from "../lib/strata.js";

// POST /mode { mode: "local" | "lan", restart?: boolean }
// Changes the Strata config's `host` field (and generates an api_key when
// switching to LAN and none exists). When `restart` is true and the config
// actually changed, the running service is restarted afterwards.
export default function registerModeRoutes(app, ctx) {
  app.post("/mode", async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ saved: false, error: "请求体必须是 JSON" }, 400);
    }

    const mode = body?.mode;
    if (mode !== "local" && mode !== "lan") {
      return c.json({ saved: false, error: "mode 必须是 local 或 lan" }, 400);
    }

    try {
      const result = await setHostMode(ctx, mode);
      if (body?.restart && result.saved) {
        result.restart = await restartService(ctx);
      }
      return c.json(result);
    } catch (e) {
      return c.json({ saved: false, error: String(e?.message || e), validation: e?.validation }, 400);
    }
  });
}
