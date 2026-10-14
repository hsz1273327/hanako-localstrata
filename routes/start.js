// POST /start — start the service with the chosen profile.
// GET  /start — first-run setup progress (polling contract, same shape as
//               routes/update.js).
//
// The body may carry `{ profileId }`, the profile picked on the stop page. It
// is persisted as the active profile and then started. Only a local profile
// with no usable config enters the first-run job (setup.py → config → serve);
// a container profile performs its own setup through the entrypoint.
import { startService, getStatus, selectProfile } from "../lib/strata.js";
import { beginFirstRun, getFirstRunState, needsInitialSetup } from "../lib/firstrun.js";

export default function registerStartRoutes(app, ctx) {
  app.post("/start", async (c) => {
    let body = {};
    try {
      body = await c.req.json();
    } catch {
      /* body is optional */
    }
    const profileId = typeof body?.profileId === "string" ? body.profileId : undefined;

    try {
      if (profileId) await selectProfile(ctx, profileId);
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
      return c.json({ started: false, error: String(e?.message || e), validation: e?.validation }, 500);
    }
  });

  // First-run progress. Returns the last known job state (an idle object when
  // no first run has happened), so the UI can poll unconditionally.
  app.get("/start", (c) => c.json(getFirstRunState()));
}
