// POST /start — start the service.
// GET  /start — first-run setup progress (polling contract, same shape as
//               routes/update.js).
//
// Normal (existing config) starts are unchanged: `startService()` is called
// directly and its result is returned synchronously. Only when there is no
// usable config does the first-run job kick in: local runs `setup.py --setup`
// and then starts the server; docker creates the container with GGUF_DIR and
// follows the entrypoint's setup pass. That job is backgrounded so the UI can
// show staged progress (download → convert → config → load).
import { startService, getStatus } from "../lib/strata.js";
import { beginFirstRun, getFirstRunState, needsInitialSetup } from "../lib/firstrun.js";

export default function registerStartRoutes(app, ctx) {
  app.post("/start", async (c) => {
    try {
      const status = await getStatus(ctx);
      if (status.state === "unsupported") {
        return c.json({ started: false, state: "unsupported", error: status.reason });
      }
      if (needsInitialSetup(status)) {
        const result = await beginFirstRun(ctx);
        // The status can change between the check above and the job's own
        // check (e.g. a config appeared). Fall back to a normal start then.
        if (result.needed) return c.json(result);
      }
      return c.json(await startService(ctx));
    } catch (e) {
      return c.json({ started: false, error: String(e?.message || e) }, 500);
    }
  });

  // First-run progress. Returns the last known job state (an idle object when
  // no first run has happened), so the UI can poll unconditionally.
  app.get("/start", (c) => c.json(getFirstRunState()));
}
