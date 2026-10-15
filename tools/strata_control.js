import { startService, stopService, restartService, redactSecretsForModel } from "../lib/strata.js";

export const name = "strata_control";
export const description =
  "控制本地 Strata 推理服务的启动、停止或重启。参数 action 取值：start / stop / restart。返回 JSON 结果。";
export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["start", "stop", "restart"],
      description: "要执行的操作",
    },
  },
  required: ["action"],
};
export const sessionPermission = { kind: "external_side_effect" };

// v2 registration factory. `sdk` is captured for lib/strata.js; `input` is the
// model-supplied arguments (plus the host-injected `context`).
export function strataControlTool(sdk) {
  return {
    name,
    description,
    parameters,
    sessionPermission,
    execute: async (input) => {
      const { action } = input || {};
      let result;
      if (action === "start") result = await startService(sdk);
      else if (action === "stop") result = await stopService(sdk);
      else if (action === "restart") result = await restartService(sdk);
      else throw new Error(`未知 action: ${action}（应为 start / stop / restart）`);

      // The lifecycle result can embed status-shaped data (the effective key, a
      // container's environment); strip secrets before the model sees it.
      return { content: [{ type: "text", text: JSON.stringify(redactSecretsForModel(result), null, 2) }] };
    },
  };
}
