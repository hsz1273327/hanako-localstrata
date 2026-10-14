import { stopService } from "../lib/strata.js";

// Map a stopService() result onto the HTTP response.
//
// A stop that could not touch anything must not look like a success: the panel
// only inspects `res.ok` (it never reads the body for /stop), so answering 200
// here turned "the service is still running and I could not stop it" into a
// silent no-op. `already` (nothing local was running) stays a 200 — stopping a
// stopped service is not an error.
export function stopResponse(result) {
  const body = result && typeof result === "object" ? result : { stopped: false };
  if (body.already || body.stopped) return { status: 200, body };
  return {
    status: 409,
    body: { ...body, error: body.error || "停止服务失败：没有可停止的目标" },
  };
}

export default function registerStopRoutes(app, ctx) {
  app.post("/stop", async (c) => {
    try {
      const { status, body } = stopResponse(await stopService(ctx));
      return c.json(body, status);
    } catch (e) {
      return c.json({ stopped: false, error: String(e?.message || e) }, 500);
    }
  });
}
