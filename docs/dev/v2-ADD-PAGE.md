# 任务：给 hanako-localstrata 加整页（page）形态

## ⚠️ 先读
- `v2-MIGRATION-BRIEF.md`（v2 知识）
- `BRIEF.md`（项目背景）

## 背景
当前 app 只有一张**普通卡片**（`contributes.cards` id=panel），入口在"卡片中心"里，**太隐蔽**。

用户要的是**侧边栏可见的入口** —— v2 里对应 **整页（page）** 形态。

## 参考实现（重要）

`/home/hsz/.hanako/apps/session-insight/manifest.json` 是现成的范例，它的写法：

```json
"cards": [
  {
    "id": "panel",
    "title": "会话用量·工作台",
    "description": "...",
    "route": "/panel.html",
    "cardForm": "flush",
    "titlebar": "translucent",
    "realization": "page",        // ← 整页
    "siteNavEntry": true,         // ← ★ 侧边栏常驻入口
    "face": { "image": "assets/cover-workbench.webp" }
  },
  {
    "id": "widget",
    "title": "会话用量·实时用量",
    "route": "/widget.html",      // ← 普通卡片（画布常驻）
    "face": { "image": "assets/cover-live.webp" }
  }
]
```

**关键**：`realization: "page"` + `siteNavEntry: true` = 页面出现在**侧边栏 + 页面切换条**。

## 要做的改动

### manifest.json

把现有的 `cards` 改成**两张卡**（参考 session-insight 的做法）：

```json
"cards": [
  {
    "id": "console",
    "title": "Strata 控制台",
    "description": "监控并启停本地 Strata 推理服务",
    "route": "/panel.html",
    "cardForm": "flush",
    "realization": "page",       // 整页
    "siteNavEntry": true,        // 侧边栏入口
    "face": { "image": "assets/cover.svg" }
  }
]
```

**如果只想保留一张**：直接给现有 `panel` 卡加 `realization: "page"` + `siteNavEntry: true` 即可。

**建议**：先只做一张 page 卡（简单），验证效果后再考虑加普通卡片。

### 需要的封面图

`face.image` 指向 `ui/assets/` 下的图片（PNG/WebP/SVG）。现在用的是 `cover.svg`（scaffold 生成的）。**检查它是否存在且有效**，没有就用 `assets/icon.svg` 复制一份过去。

### minAppVersion 检查

`siteNavEntry` 有最低版本要求 —— **查 APPS.md 确认**（搜 "siteNavEntry"），必要时提高 `minAppVersion`。

### 同步

改完同步到 `/home/hsz/.hanako/apps/hanako-localstrata/`（用 rsync，排除 `.git`、`v1-reference`、`test`、`*.md` 里只留必要的）。

## 验证

```bash
node /home/hsz/.hanako/skills/hana-app-creator/scripts/validate_app.mjs --dir .
```

要求 **0 error**。

## ⚠️ 注意

- 用户要的是**侧边栏入口**（page），不是卡片中心（card）
- 不要动 `sdk/` 目录
- Strata 服务在运行（0.1.41），别停它
- 保持现有 UI 功能不变（只是入口形态变了）
