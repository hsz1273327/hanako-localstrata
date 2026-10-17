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

## 三、`app/input.panels` 是另一条路，而且我们**不申报**它

- `app/input.panels` 守的是 `hana.inputPanel.*`，位置是**输入框上方**的输入面板，不是右栏
  （`hana-app-creator/SKILL.md:354`：`app/input.panels` = custom pages above a conversation's input box）。
- **不申报**：我们 UI 里一处都没调 `hana.inputPanel.*` —— 树里那 2 个命中是 vendored SDK
  （`ui/assets/sdk.js:1843 / :1862`）**自己的实现**，不是我们的调用。没人要"输入框上方面板"这个东西。
- 申报一条没人用的能力 = 一条用不上的授权 + 一次**强制重新批准**（`approval.appDeclaration`
  只覆盖 capabilities + network，改了它就得重点一次）。
- 规则由 `test/manifest.test.js` 的 "we do not claim capabilities our UI never uses" 守着：
  `capabilities` 必须**逐字**等于那 5 条，并且我们 UI 里不出现 `hana.inputPanel.`。

## 四、落地的 manifest 形状

```jsonc
"cards": [
  { "id": "panel", "route": "/panel.html", "realization": "page", "siteNavEntry": true,
    "face": { … } },                       /* 全功能页：**不带** functionPanel */
  { "id": "dashboard", "route": "/card.html", /* 不写 realization = 画布卡 */
    "face": { … },
    "functionPanel": { "id": "console-dashboard", "label": "Strata", "route": "/card.html" } }
]
```

- **整页卡**保留原样（站点导航入口 + 全功能），**不带** `functionPanel`：整页已经什么都有了，
  没人要求它在右栏再放一份。（平台允许这么组合——白板 `board` 就是"整页 + 右栏"——只是我们不需要。）
- **画布卡**让卡片中心能拖；拖到某个 **page**（主页 / 新页面）上，右栏就是我们的窄面板。
  右栏只由画布卡提供：整页上不出现右栏。
- **精简视图**是新文件 `ui/card.html`（+`assets/card.js` / `card.css`）：
  只显示 **状态 · 解码/预取速度 · 启停**（VRAM/RAM 与「打开完整面板」已按产品意见去掉）。
  后端复用 **同两条路由**（`GET /status`、`POST /start` / `POST /stop`），没有新接口。
- **为什么不是 `/panel.html?compact=1`**：`ui/assets/panel.js` 是 ~2500 行的模块，同时带着配置文件区、表一、
  参数编辑 6 组、setup 弹窗、profile 抽屉和日志轮询。紧凑模式不是加一段 CSS 就能收敛的，得给每一段渲染和轮询加护栏，
  而且这份代价每次开卡都要付。卡片是"一眼看完"的产品面，独立成页更干净。
- **右栏也用同一个 `/card.html`**：右栏同样是一列窄栏、同一件事（看一眼就走）；把整页塞进右栏会把配置区和参数编辑
  挤到不可用，还会额外拉起整页的定时器。完整功能由整页承担。
- **`minAppVersion` 不动**（`1.1.0-beta`）：我们没用 `titleMode` / `structural` /
  `edge-to-edge` / `service` 这些有版本门槛的字段，`cardForm: "flush"` 是 legacy 但仍加载。

## 五、真机怎么验（一眼看出成没成）

1. 重载/批准新版 App 后，打开 **卡片中心**：应当出现两个磁贴——
   「Strata Console」（整页，拖不动）和「Strata 状态」（画布卡，**能拖**）。
2. 把「Strata 状态」拖到**主页（page）**上：右侧功能面板应出现标题 **Strata** 的窄面板
   （状态 / 解码与预取速度 / 启停）。
3. 若把它拖到**桌面（home）**上：平台会拒绝并报
   `…requires function panel contributions but … rejects them` —— 这是设计如此，不是 bug。
