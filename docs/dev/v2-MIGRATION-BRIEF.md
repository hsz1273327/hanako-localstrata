# v2 迁移资料（给 AI 协作者）

Hana 已升级到 **1.1.0-beta**，插件体系从 v1 变成 **v2 App**。本项目要从 v1 迁到 v2。

## 官方文档位置（权威，遇事查它）

```
<HANA_HOME>/artifacts/server/1.1.0-beta-linux-x64-a00e70f7a4cb0541-gdb59a912a88a8f92/APPS.md
<HANA_HOME>/artifacts/server/1.1.0-beta-linux-x64-a00e70f7a4cb0541-gdb59a912a88a8f92/APPS_EN.md
```

创建工具（scaffold + 校验）：
```
<HANA_HOME>/skills/hana-app-creator/
├── SKILL.md                      # 开发指南
├── scripts/create_hana_app.py    # 生成骨架
├── scripts/validate_app.mjs      # 校验
├── scripts/check_env.mjs         # 环境能力检查
└── references/builder.md         # 开发调试流程
```

## v1 → v2 对照

| | v1 | **v2** |
|---|---|---|
| 目录 | `<HANA_HOME>/plugins/<id>/` | **`<HANA_HOME>/apps/<id>/`**（目录名必须==manifest.id）|
| manifest | `manifestVersion: 1` | **`manifestVersion: 2`（必须恰好 2）** |
| 入口 | `index.js`（class + onload）| **`entry`（默认 index.js）用 `defineApp(sdk => ...)`** |
| 权限 | `trust: "full-access"` | **`capabilities: string[]`**（按需声明，见下）|
| 配置 | `contributes.configuration` | **`contributes.settings: { schema }`** |
| UI | `contributes.widget/page`（iframe）| **`contributes.cards`（黑板卡）/ `contributes.settings.ui`** |
| HTTP 路由 | `routes/*.js` | **`routes/*.js`（兼容！）** 或 `ctx.routes.register()` |
| 工具 | `tools/*.js` | **`sdk.tools.register()`** |
| 前端握手 | `postMessage({type:'ready'})` | **`hana.ready()`**（SDK）|
| 前端调后端 | `fetch('/api/plugins/...')` | **`hana.api.fetch(...)`** |

## v2 目录结构（scaffold 生成的标准形态）

```
<HANA_HOME>/apps/hanako-localstrata/
├── manifest.json          # v2 清单
├── index.js               # 入口（defineApp）
├── sdk/                   # 官方 SDK（脚手架复制进来的，随包分发，别手改）
├── lib/                   # 自己的模块
├── routes/                # HTTP 路由（可选，兼容 v1 写法）
├── ui/                    # 静态 UI 树
│   ├── panel.html
│   └── assets/
│       ├── sdk.js         # UI 侧 SDK（hana）
│       ├── app-ui.js/css  # 官方 UI 控件
│       ├── panel.js       # 页面逻辑
│       ├── panel.css
│       └── cover.svg      # 卡片封面（face.image 指向它）
└── assets/
    └── icon.svg           # App 图标（manifest.icon）
```

## manifest v2 示例

```json
{
  "manifestVersion": 2,
  "id": "hanako-localstrata",
  "name": "Strata 控制台",
  "version": "1.0.0",
  "entry": "index.js",
  "icon": "assets/icon.svg",
  "capabilities": ["app/tools.expose-to-model", "app/ui.open-external", "app/ui.clipboard-write"],
  "network": { "allowedHosts": ["api.github.com"], "methods": ["GET"], "defaultTimeoutMs": 5000 },
  "contributes": {
    "settings": {
      "title": "Local Strata",
      "schema": { "properties": { "...": {} } }
    },
    "cards": [
      {
        "id": "panel",
        "title": "Strata 控制台",
        "description": "监控并启停本地 Strata 推理服务",
        "route": "/panel.html",
        "face": { "image": "assets/cover.svg" }
      }
    ]
  }
}
```

**能力词对照**（v1 的 hostCapabilities → v2 capabilities）：
| v1 | v2 |
|---|---|
| `external.open` | `app/ui.open-external` |
| `clipboard.writeText` | `app/ui.clipboard-write` |
| （进程/文件操作）| v1 有 full-access 直接干；v2 用 Node 能力在 `index.js`/`routes/` 里直接做（App 服务端有完整 Node 权限）|

## index.js 入口写法

```js
import { defineApp } from "./sdk/app-contract/server-client.js";

export default defineApp(async (sdk) => {
  await sdk.tools.register({
    name: "strata_status",
    description: "查询本地 Strata 服务状态",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "..." }] }),
  });
});
```

## routes/ 兼容（重要，几乎可原样搬）

`routes/` 目录**顶层**的 `.js` / `.ts` 文件会被自动挂到：
```
/api/apps/<appId>/routes/<文件名>/<子路径>
```

三种导出都认（和 v1 一模一样）：
```js
// 1. 静态 Hono 子 app
export default new Hono().get("/ping", c => c.json({ok:true}));
// 2. 工厂 / 3. 具名 register
export default function register(app, ctx) { app.get("/x", c => c.json({})); }
export function register(app, ctx) { ... }
```

handler 里能拿身份：`c.get("appRequestContext")` → `{ appId, agentId, principal }`。

## ui/ 页面写法

```html
<link rel="stylesheet" href="./assets/panel.css">
<link rel="stylesheet" href="./assets/app-ui.css">
<main data-hana-app-ui>...</main>
<script type="module" src="./assets/panel.js"></script>
```

```js
import { hana } from './sdk.js';
import { appUi, appUiIcon, mountAppUi } from './app-ui.js';

hana.ready();                          // 握手（替代 postMessage）
const res = await hana.api.fetch('status');   // 调本 App 的 route（替代 fetch('/api/plugins/...')）
await hana.external.open(url);         // 需 capability: app/ui.open-external
await hana.clipboard.writeText(text);  // 需 capability: app/ui.clipboard-write
```

**注意**：`hana.api.fetch('status')` 会自动带上本 App 的 surface 凭证，并解析成 `/api/apps/hanako-localstrata/routes/<file>/status`（取决于你把 route 放在哪个文件里）。

## 可复用的 v1 代码

仓库 `v1-reference/` 里是完整的 v1 实现，**以下可直接搬**（改动极小）：
- `lib/strata.js`、`lib/process.js`、`lib/python.js` — **纯 Node 逻辑，原样可用**
- `routes/*.js` — HTTP 路由，**写法兼容**（只需确认挂载路径前缀变化）
- `tools/*.js` — 需改写成 `sdk.tools.register()` 形式

**需要重写的**：
- `manifest.json`（v1 → v2）
- `index.js`（class → defineApp）
- `assets/*`（widget UI）→ `ui/*`（卡片 UI）

## 开发验证

```bash
# 校验
node <HANA_HOME>/skills/hana-app-creator/scripts/validate_app.mjs <app目录>

# 环境能力检查
node <HANA_HOME>/skills/hana-app-creator/scripts/check_env.mjs
```

安装位置：`<HANA_HOME>/apps/hanako-localstrata/`（目录名必须等于 manifest.id）。
