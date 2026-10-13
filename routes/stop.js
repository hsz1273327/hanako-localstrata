import { stopService } from "../lib/strata.js";

export default function registerStopRoutes(app, ctx) {
  app.post("/stop", async (c) => {
    try {
      return c.json(await stopService(ctx));
    } catch (e) {
      return c.json({ stopped: false, error: String(e?.message || e) }, 500);
    }
  });
}
