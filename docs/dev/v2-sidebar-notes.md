# 右侧功能面板：平台的两道门与我们的取舍（2026-10-18）

产品初衷是「右侧边栏常驻小面板」。`realization: "page"` 是当年以为平台不支持时的退路。
这次把平台的两道门追清楚了，结论是：**画布卡 + `functionPanel` 都声明，右栏才真的会出现**，
而它们**各自**决定两件不同的事。

## 一、门 A：能不能"起拖"（卡片中心的磁贴）

`.../desktop/dist-renderer/assets/CapabilitiesPanel-CqtGRIdO.js`（单行压缩，偏移为字符位置）

```js
// 偏移 93240
function Us(e){ return e.surface === "page" || e.pluginCard?.realization === "page" }

// 偏移 110471 —— 拖拽手柄
gp({ enabled: n.draggable !== !1 && !Us(n), getIntent: c })

// 偏移 93317 —— 同一条件让载荷变 null
function Op(e,n){ if (Us(e)) return null; ... }
```
`Op` 返回 null 时发出的载荷是 **`chalkboard-layout-card-create-unavailable`**——
这就是"这张磁贴不可拖"的平台写法。

**结论**：整页卡（`realization: "page"`）的磁贴拖不动；**画布卡**（不写 `realization`）才能拖。
与"内置 / 第三方"无关（`owner: "plugin"` 的条目也能拖）。

## 二、门 B：右侧功能面板在哪生效

`.../assets/contributed-keybindings-CWd7VC-R.js`（偏移 64197）：

```js
if (n?.kind !== "plugin-webview" || n.channel !== "app" || !r) return null;
const s = r.functionPanel?.routeUrl ?? null, c = r.functionPanel?.service;
return !s && !c ? null : { appId: n.pluginId, routeUrl: s, service: c, title: … };
```
即：**当前激活的卡片**是 app 的 webview 卡、且它的插件声明里有 `functionPanel`，右栏才有内容。

`.../assets/index-DbjRpadG.js`（偏移 366346，`jY`）——**真正的 surface 门**：

```js
const l = oP(e);
if (!l.capabilities.acceptsFunctionPanelContributions) return [];   // 面板贡献直接为空
const u = l.pageId ?? e.activePageId; …
```
以及同一文件偏移 561451（`sU`，放置校验）：

```js
if (tU(e) && !n.acceptsFunctionPanelContributions)
  throw new Q("INVALID_STRUCTURE", `card ${e.id} requires function panel contributions but ${t} rejects them`);
```

**surface 能力表**（`index-DbjRpadG.js` 里的常量）：

| surface | `acceptsFunctionPanelContributions` | 含义 |
| --- | --- | --- |
| `page`（`surface:page:<id>`，含 page-chat） | **true** | 右栏可用 |
| home / 桌面（`card:studio-home`） | **false** | 右栏为空 |
| detached（拆窗） | **false** | 右栏为空（与 SKILL.md 里"跟随到拆窗"的说法有出入，以代码为准） |

**所以不是"声明了却不显示"的坑**：在 page 上它一定出现；而在 home / detached 上，
带 `functionPanel` 的卡片会被**拒绝放置**并报 `INVALID_STRUCTURE`（不是静默忽略）。

## 三、`app/input.panels` 是另一条路（这次没加）

- `app/input.panels` 守的是 `hana.inputPanel.*`，位置是**输入框上方**的输入面板，不是右栏
  （`hana-app-creator/SKILL.md:354`：`app/input.panels` = custom pages above a conversation's input box）。
- 我们 UI 里**一处都没调** `hana.inputPanel.*`：树里那 2 个命中是 vendored SDK
  （`ui/assets/sdk.js:1843 / :1862`）**自己的实现**，不是我们的调用。
- 所以不存在"静默拒绝"；加这个能力只会多一条无用的授权。测试
  `test/manifest.test.js`（"we do not claim capabilities our UI never uses"）钉住了这一点：
  什么时候我们真的开始呈现输入面板，那条断言会先红。

## 四、落地的 manifest 形状

```jsonc
"cards": [
  { "id": "panel", … "realization": "page", "siteNavEntry": true,
    "functionPanel": { "id": "console-panel", "label": "Strata", "route": "/sidebar.html" } },
  { "id": "dashboard", … /* 不写 realization = 画布卡 */
    "functionPanel": { "id": "console-dashboard", "label": "Strata", "route": "/sidebar.html" } }
]
```

- **整页卡保留**（站点导航入口），并且也能带 `functionPanel`（白板 `board` 就是这个形状，
  是"整页 + 右栏"的现成证据）。
- **画布卡**让卡片中心能拖；拖到某个 **page**（主页 / 新页面）上，右栏就是我们的窄面板。
- **窄面板**是新文件 `ui/sidebar.html`（+`assets/sidebar.js` / `sidebar.css`）：
  只显示 状态 · 解码/预取速度 · VRAM/RAM · 一键启停 + 「打开完整面板」。
  后端复用 **同三条路由**（`GET /status`、`POST /start`、`POST /stop`），没有新接口。
- **`minAppVersion` 不动**（`1.1.0-beta`）：我们没用 `titleMode` / `structural` /
  `edge-to-edge` / `service` 这些有版本门槛的字段，`cardForm: "flush"` 是 legacy 但仍加载。

## 五、真机怎么验（一眼看出成没成）

1. 重载/批准新版 App 后，打开 **卡片中心**：应当出现两个磁贴——
   「Strata Console」（整页，拖不动）和「Strata 状态」（画布卡，**能拖**）。
2. 把「Strata 状态」拖到**主页（page）**上：右侧功能面板应出现标题 **Strata** 的窄面板
   （状态 / 速度 / VRAM / RAM / 启停 / 打开完整面板）。
3. 若把它拖到**桌面（home）**上：平台会拒绝并报
   `…requires function panel contributions but … rejects them` —— 这是设计如此，不是 bug。
