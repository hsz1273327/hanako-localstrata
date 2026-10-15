import { getStatus, redactSecretsForModel } from "../lib/strata.js";

export const name = "strata_status";
export const description =
  "查询本地 Strata 推理服务的状态。返回 JSON：运行状态(state)、模型、上下文长度、请求数、显存/内存占用、最近一次 pp/tg 生成速度、专家缓存命中率和 KV 命中率。";
export const parameters = {
  type: "object",
  properties: {},
};
export const sessionPermission = { readOnly: true };

// v2 registration factory. The execute closure captures the AppSdk so
// lib/strata.js can read config / network through the same context the entry
// received (v2 no longer injects the plugin ctx into the tool execute args).
export function strataStatusTool(sdk) {
  return {
    name,
    description,
    parameters,
    sessionPermission,
    execute: async () => {
      const status = await getStatus(sdk);
      // The status object carries the effective API key (network.apiKey) and the
      // running container's environment; a model-facing payload must not.
      return { content: [{ type: "text", text: JSON.stringify(redactSecretsForModel(status), null, 2) }] };
    },
  };
}
