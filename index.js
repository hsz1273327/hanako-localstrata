// hanako-localstrata v2 App entry.
//
// Registers the two Agent tools and performs the optional auto-start of the
// Strata service (the v1 lifecycle's onload responsibility). Routes live in
// routes/ and are auto-mounted by the host at
// /api/apps/hanako-localstrata/routes/... .
import { defineApp } from "./sdk/app-contract/server-client.js";
import { getStatus, startService, getLatestVersion } from "./lib/strata.js";
import { strataStatusTool } from "./tools/strata_status.js";
import { strataControlTool } from "./tools/strata_control.js";

export const name = "hanako-localstrata";

export default defineApp(async (sdk) => {
  await sdk.tools.register(strataStatusTool(sdk));
  await sdk.tools.register(strataControlTool(sdk));

  await sdk.logger.info("hanako-localstrata loaded");

  // Warm the release-version cache in the background so the card's first
  // status poll already has an answer (never blocks startup).
  getLatestVersion(sdk);

  try {
    const autoStart = await sdk.config.get("autoStart");
    if (autoStart === true) {
      const status = await getStatus(sdk);
      if (status.state === "stopped") {
        const result = await startService(sdk);
        await sdk.logger.info("autoStart: strata starting", { pid: result.pid });
      } else {
        await sdk.logger.info("autoStart: strata already", { state: status.state });
      }
    }
  } catch (err) {
    await sdk.logger.error("autoStart check failed", err?.message || err);
  }
});
