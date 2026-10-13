import { readAllConfig, resolveApiKey, resolvePort } from "../lib/strata.js";

// Proxies Strata's request history. The endpoint needs a bearer API key when
// the server has one configured; on a keyless local server it may 401, so we
// degrade gracefully and let the UI explain what is missing.
export default function registerRequestsRoutes(app, ctx) {
  app.get("/requests", async (c) => {
    const cfg = await readAllConfig(ctx);
    const apiKey = resolveApiKey(cfg);
    const port = resolvePort(cfg);
    const headers = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    let res;
    try {
      // Bare fetch is denied inside the AppHost sandbox; use the manifest-gated
      // host network door when present (unit tests fall back to global fetch).
      const fetcher = ctx?.network?.fetch ? ctx.network.fetch.bind(ctx.network) : fetch;
      res = await fetcher(`http://127.0.0.1:${port}/api/requests`, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
    } catch (e) {
      return c.json({ ok: false, error: `无法连接 Strata: ${e?.message || e}`, requests: [] });
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = data?.error?.message || data?.detail || `HTTP ${res.status}`;
      const friendly =
        res.status === 404
          ? "Strata 未开启请求监控（需要在配置里设置 api_monitor: true 或加 --api-monitor）"
          : message;
      return c.json({
        ok: false,
        status: res.status,
        error: friendly,
        needsKey: res.status === 401 || res.status === 403,
        requests: [],
      });
    }

    const requests = Array.isArray(data?.requests) ? data.requests : Array.isArray(data) ? data : [];
    return c.json({ ok: true, requests });
  });
}
