# 任务：把 hanako-localstrata 从 v1 插件迁移到 v2 App

## ⚠️ 开工前必读

1. **`v2-MIGRATION-BRIEF.md`**（本仓库根目录）—— v2 的核心知识，**先读它**
2. **`BRIEF.md`** —— 项目背景（Strata 是什么、功能清单、用户偏好）
3. **`v1-reference/`** —— v1 的完整实现（要迁移的源）
4. 需要查权威细节时读官方文档：
   `<HANA_HOME>/artifacts/server/1.1.0-beta-linux-x64-a00e70f7a4cb0541-gdb59a912a88a8f92/APPS.md`

## 目标

把 v1 插件（`v1-reference/`）完整迁移为 v2 App，**功能不减**，安装在 `<HANA_HOME>/apps/hanako-localstrata/`。

## 当前仓库状态

```
hanako-localstrata/
├── v1-reference/          ← v1 完整实现（源）
├── sdk/                   ← v2 官方 SDK（scaffold 生成，别动）
├── ui/                    ← v2 UI 骨架（scaffold 生成，要改）
│   ├── panel.html
│   └── assets/{sdk.js, app-ui.js, app-ui.css, panel.js, panel.css, cover.svg}
├── manifest.v2.json       ← v2 清单骨架（要改成正式 manifest.json）
├── index.v2.js            ← v2 入口骨架（要改成正式 index.js）
├── index.js / manifest.json   ← v1 的（迁移完可删或留参考）
├── lib/ routes/ tools/ assets/ ← v1 的（lib/routes 要搬过来）
└── v2-MIGRATION-BRIEF.md
```

## 迁移步骤

### 1. manifest.json（v2）

参考 `v1-reference/manifest.json` 的功能，写成 v2 格式：

- `manifestVersion: 2`
- `id: "hanako-localstrata"`（= 目录名）
- `name: "Strata 控制台"`
- `version: "1.0.0"`
- `entry: "index.js"`
- `icon: "assets/icon.svg"`（需把图标放到 `assets/`，scaffold 用的是 `ui/assets/cover.svg`，图标要单独放）
- `capabilities`: 按需声明
  - `app/tools.expose-to-model`（注册工具）
  - `app/ui.open-external`（"打开网页"按钮）
  - `app/ui.clipboard-write`（复制按钮）
- `network`: `{ "allowedHosts": ["api.github.com"], "methods": ["GET"], "defaultTimeoutMs": 5000 }`（版本检查要访问 GitHub）
- `contributes.settings.schema`: 迁移 v1 的 configuration（strataDir / pythonPath / configFile / port / autoStart / refreshSec / apiKey），**默认值保持 v1 现状**（strataDir/pythonPath 为空等）
- `contributes.cards`: 一张卡
  ```json
  { "id": "panel", "title": "Strata 控制台", "description": "监控并启停本地 Strata 推理服务", "route": "/panel.html", "face": { "image": "assets/cover.svg" } }
  ```

### 2. index.js（v2 入口）

```js
import { defineApp } from "./sdk/app-contract/server-client.js";
export default defineApp(async (sdk) => { /* 注册工具 */ });
```

迁移 `v1-reference/tools/strata_status.js` 和 `strata_control.js` 为 `sdk.tools.register({...})` 形式。
（先读这两个文件看原逻辑）

### 3. lib/ 和 routes/

**直接搬过来**（`v1-reference/lib/` → `lib/`，`v1-reference/routes/` → `routes/`）。
这两个基本原样可用（v2 的 routes/ 目录兼容 v1 写法）。

**但要检查**：
- routes handler 里 v1 特有的 ctx 用法（如 `ctx.pluginId`）在 v2 是否还成立 —— 查 APPS.md 的 "handler 请求上下文"
- 挂载路径：v1 是 `/api/plugins/<id>/`，v2 是 `/api/apps/<id>/routes/<文件名>/`
  - 前端调用处要相应调整（见第 4 步）

### 4. ui/（卡片页面，替代 v1 的 widget）

**这是工作重点。** 把 `v1-reference/assets/`（widget 的 index.html/app.js/style.css）迁移成 v2 的 `ui/panel.html` + `ui/assets/panel.js` + `ui/assets/panel.css`。

**关键差异**：
| v1 | v2 |
|---|---|
| `postMessage({type:'ready'})` | `hana.ready()` |
| `fetch('/api/plugins/hanako-localstrata/xxx')` | `hana.api.fetch('xxx')` |
| 引入方式：独立 html | 用现有 `ui/panel.html` 骨架（含 `data-hana-app-ui`、app-ui.css）|
| `external.open` 请求 | `hana.external.open(url)` |
| clipboard 请求 | `hana.clipboard.writeText(text)` |

**功能要保持**（v1 已有的全部）：
- 状态卡片：状态灯 / 模型 / 运行时长 / 端口 / 地址 / API Key
- 版本检查 + 更新按钮
- 网络模式切换（本地/局域网，带二次确认）
- 启停按钮（图标 + 二次确认）
- 操作遮罩
- 参数编辑（折叠）
- 日志（折叠）
- 资源占用（显存/内存）
- **配置表单**（未配置/未安装时的引导，两步流程）

**尺寸变化**：v2 卡片比 v1 侧栏 widget **宽**（可拖拽调整），布局可以放松，不用再挤。

### 5. 安装 + 验证

```bash
# 1. 校验
node <HANA_HOME>/skills/hana-app-creator/scripts/validate_app.mjs <repo>

# 2. 安装到 apps 目录
mkdir -p <HANA_HOME>/apps
rsync -a --delete --exclude='.git' --exclude='v1-reference' --exclude='*.v2.*' \
  <仓库>/ <HANA_HOME>/apps/hanako-localstrata/
```

**注意**：`sdk/` 目录很大（官方 SDK），必须一起复制。

### 6. 清理

迁移完成后，仓库里：
- 删掉 `manifest.v2.json` / `index.v2.js`（临时文件）
- v1 的 `index.js` / `manifest.json` / `assets/` 可以删（`v1-reference/` 已保留副本）
- `lib/` `routes/` `tools/` 用新迁移的版本

## 验证标准

1. `validate_app.mjs` 通过
2. 装到 `<HANA_HOME>/apps/hanako-localstrata/` 后，Hana 能识别（可能需要用户在设置里批准）
3. 卡片能打开，显示状态
4. 工具能被 Agent 调用（`strata_status`）
5. 路由可用（`/api/apps/hanako-localstrata/routes/...`）

## ⚠️ 注意

- **别动 `sdk/` 目录**（官方 SDK，脚手架复制进来的）
- Strata 服务当前**正在运行**（0.1.41），测试时不要停它
- 用户偏好：**动手验证、以实物为准**；UI 极简克制（黑白图标 + 颜色区分状态）；每项信息有明确标签
- 迁移中如果发现 v2 有 v1 做不到的能力（比如整页 page 形态、inputStatus），**先不做**，保持功能等价，之后再说
