import { getStatus } from "../lib/strata.js";

export default function registerStatusRoutes(app, ctx) {
  app.get("/status", async (c) => {
    try {
      return c.json(await getStatus(ctx));
    } catch (e) {
      return c.json({ state: "stopped", error: String(e?.message || e) }, 200);
    }
  });
}
