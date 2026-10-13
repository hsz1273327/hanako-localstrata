import { startService } from "../lib/strata.js";

export default function registerStartRoutes(app, ctx) {
  app.post("/start", async (c) => {
    try {
      return c.json(await startService(ctx));
    } catch (e) {
      return c.json({ started: false, error: String(e?.message || e) }, 500);
    }
  });
}
