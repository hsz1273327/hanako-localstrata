# 项目背景（给 AI 协作者）

这份文档写给协助本项目的 AI（如 pi）。**开工前先读它**，它包含了必需的背景知识，读完可以直接动手，不需要再做大范围调研。

---

## 1. 这个项目是什么

**hanako-localstrata** 是一个 **OpenHanako 平台**的社区插件，用来**监控和控制本地 Strata 推理服务**。

**用户场景**：用户在自己的电脑上跑了一个 125B 大模型（通过 Strata），但每次开机都要手动敲命令拉起服务，很麻烦。这个插件的目标是在 OpenHanako 的侧栏提供一个面板，随时查看状态、一键启停。

**仓库位置**：`/home/hsz/workspace/GitHub/hsz1273327/hanako-localstrata`

---

## 2. Strata 是什么

**Strata** 是一个本地大模型推理引擎，特点是能把**远超显存容量的大模型**跑在消费级硬件上。

**用户的实际部署**：
| 项 | 值 |
|---|---|
| 项目目录 | `/data/hanako/Strata` |
| Python 环境 | `/home/hsz/miniconda3/envs/strata/bin/python`（conda 环境）|
| 服务端口 | 8080 |
| 配置文件 | `/data/hanako/Strata/strata-iq3_s.json` |
| 数据目录 | `/data/hanako/Strata-data` |
| 模型 | Qwen3.8-Flash-Next IQ3_S（125B MoE，量化后 47GB）|
| 硬件 | RTX 4060 Ti 16G + 91G 内存 + Ryzen 7700 |

**启动命令**（官方方式）：
```bash
/path/to/python /data/hanako/Strata/serve/server.py \
  --engine strata \
  --config /data/hanako/Strata/strata-iq3_s.json \
  --port 8080
```

**启动耗时**：约 2 分钟（要把 47GB 专家权重加载进内存）。

### Strata 的关键 API（插件数据来源）

```bash
# 服务状态（判断是否运行中）
GET http://127.0.0.1:8080/v1/status
# 返回：
{
  "service": "strata",
  "model": "qwen3.8-flash-next-iq3_s",
  "loaded": true,
  "engine": "0.1.38",
  "uptime_s": 2543,
  "cache_max_tokens": 262144,        # 上下文长度
  "context": {"native": 262144},
  "vision": {"enabled": true},
  "activity": {"requests": 12, "in_flight": 0}
}

# 请求历史（含速度统计，需要 API key，本机没设 key 所以可能不可用）
GET http://127.0.0.1:8080/api/requests
```

### ⚠️ 重要的坑

1. **停止服务时不要用 `pkill -f "serve/server.py"`** —— 这个模式会匹配到**执行命令的脚本自身**，导致自杀。必须用精确匹配 + 排除自身 PID。

2. **Strata 是单序列的** —— 一次只处理一个请求，多个请求会排队（不会失败，只是等）。这是设计如此，不是 bug。

3. **它的日志在** `/data/hanako/Strata/strata-iq3_s.log`，里面每个请求会打印速度：
   ```
   strata serve: prompt 17 tokens = 0 reused + 17 read in 462 ms (36.8 tok/s), 2 generated in 164 ms (12.2 tok/s)
   strata serve: decode expert cache hit rate: 28.7% (535 hits / 1863 lookups)
   strata serve: KV streaming: 90.91% of 792 block reads hit VRAM
   ```

4. **参考实现**：Strata 自带的 Web 面板是很好的参考：
   - `/data/hanako/Strata/serve/web/monitor.js` — 数据获取逻辑
   - `/data/hanako/Strata/serve/web/monitor.html` — UI 结构
   - `/data/hanako/Strata/serve/web/tokens.css` — 配色（绿 accent `#10b981`）

---

## 3. OpenHanako 是什么

**OpenHanako**（也叫 HanaAgent）是一个 **Electron 桌面 AI 助手平台**，支持插件扩展。

**插件官方文档**：https://github.com/liliMozi/openhanako/blob/main/PLUGINS.md
（如需查阅，**只读需要的章节**，不要通读全文——它有 1300+ 行）

### 插件的关键概念

**权限两级**：
- `restricted`（默认）：只能做 tools/skills/commands/agents/config
- `full-access`：额外能用 routes（HTTP 端点）、lifecycle（onload/onunload）、extensions、providers、动态注册工具

**本项目需要 `full-access`**（要用 routes 和 lifecycle）。

**三大 UI 贡献类型**：
| 类型 | 说明 |
|---|---|
| `page` | 全页面，占满窗口（顶部 tab 栏）|
| `widget` | 侧栏组件（右侧 Jian 侧栏，书桌旁）|
| `settingsTab` | 原生设置页（仅内置插件）|

**本项目以 `widget` 为主**（侧栏快速入口），后续可能加 `page`（完整设置页）。

### 目录结构约定

```
my-plugin/
├── manifest.json     # 声明（id/trust/activationEvents/contributes/ui）
├── index.js          # 生命周期入口（full-access 才需要）
├── lib/              # 自己的模块（约定，非强制）
├── routes/           # HTTP 路由（full-access）
│   └── *.js          # 每个文件 export default 一个 handler
├── assets/           # 前端静态文件（由宿主服务）
│   ├── index.html
│   ├── app.js
│   └── style.css
└── tools/            # Agent 可调用的工具
```

### 关键 API 速查

**manifest.json 结构**：
```json
{
  "manifestVersion": 1,
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "trust": "full-access",
  "activationEvents": ["onWidgetOpen"],
  "ui": { "hostCapabilities": ["external.open"] },
  "contributes": {
    "widget": {
      "title": { "zh": "名字", "en": "Name" },
      "icon": "<svg .../>",
      "route": "/widget"
    },
    "configuration": {
      "properties": { "key": { "type": "string", "title": "...", "default": "..." } }
    }
  }
}
```

**activationEvents 可选值**：
| 值 | 触发时机 |
|---|---|
| `onStartup` | 插件加载时立刻 `onload()` |
| `onWidgetOpen` | 用户打开 widget |
| `onPageOpen` | 用户打开 page |
| `onToolCall` | 任意 tool 被调用 |
| `onToolCall:name` | 指定 tool 被调用 |
| `*` | 任何触发 |

**routes handler 格式**（full-access）：
```js
export default async function handler(req, res, ctx) {
  // ctx: { pluginId, config, dataDir, log, bus, ... }
  res.json({ ... });
}
```

**widget 前端握手**：
```js
// 最简方式
window.parent.postMessage({ type: 'ready' }, '*');

// 或用 SDK（如果有构建步骤）
import { hana } from '@hana/plugin-sdk';
hana.ready();
await hana.toast.show({ message: 'ok' });
await hana.external.open('https://...');   // 需在 manifest 声明 hostCapabilities
```

**注意**：widget/page 用 **iframe 渲染**，静态资源在 `assets/` 下，由宿主通过 `/api/plugins/{pluginId}/assets/...` 服务。iframe URL 会带 `hana-theme` 和 `hana-css` 参数，可引主题 CSS 保持一致。

**widget 的 route 必须有对应的 `routes/*.js` 返回 HTML**（宿主不会自动把 `assets/index.html` 当 widget 页面）。

### 开发调试

用户已开启 Hana 的插件开发工具，Agent 可直接用：
- `plugin_dev_install` — 安装插件（指向源码目录）
- `plugin_dev_reload` / `plugin_dev_enable` / `plugin_dev_disable`
- `plugin_dev_diagnostics` — 查状态、日志、surface 列表
- `plugin_dev_list_surfaces` / `plugin_dev_describe_surface` — 调试 UI

调试顺序：**install → diagnostics 看有没有 error → list_surfaces → describe_surface**

---

## 4. 用户偏好（重要）

- **动手验证优先**，不要空谈理论
- **反感绕远路和自作主张** —— 有明确要求就照做，别自由发挥
- **先跑通框架，再做细节** —— MVP 优先
- **纯本地**，不要引入对外暴露
- 代码简洁清晰，不过度设计

---

## 6. 更新功能的环境判断规则（重要）

插件的「更新 Strata」功能需要决定**用哪个 CUDA 编译**。规则：

**判据：看 `pythonPath` 所在环境有没有自带的 nvcc**

```js
const envRoot = path.dirname(path.dirname(pythonPath));
const hasOwnCuda = fs.existsSync(path.join(envRoot, "bin", "nvcc"));
```

| 环境 | hasOwnCuda | 用哪个 CUDA | 说明 |
|---|---|---|---|
| conda（装了 cuda-toolkit）| **true** | **环境自带的** | 用户刻意隔离，用错 CUDA 会编不了 |
| uv / venv / virtualenv | false | **系统的** | 它们不带 CUDA |
| 系统 python | false | **系统的** | |

**不要用 `sys.prefix != sys.base_prefix` 判断 conda**——实测在 conda 环境里也返回 False，不可靠。
**就用「同环境里有没有 nvcc」这个直接判据。**

环境自带 CUDA 时，编译要注入（实测必需）：
```
STRATA_NVCC={envRoot}/bin/nvcc
NVCC_PREPEND_FLAGS="-Xlinker --allow-shlib-undefined"
LDFLAGS="-Wl,--allow-shlib-undefined"
```
（后两个解决 conda 链接器与系统 glibc 的符号不兼容；系统 CUDA 环境不需要）

## 7. 当前进度

**已完成**：
- Widget：状态（带标签）/ 版本检查 / 网络模式切换（本地=电脑主机图标，局域网=网络拓扑图标）/ 启停图标按钮 / 操作遮罩 / 参数编辑 / 日志
- 更新功能：环境判断 + 更新流程 + 日志（`routes/update.js`）
- 配置项在 Hana 设置页（strataDir / pythonPath / configFile / port / autoStart / refreshSec / apiKey）

**待办**：无（功能基本完整，进入维护/微调阶段）

---

## 8. 平台支持（跨平台适配）

| 平台 | 支持 | 说明 |
|---|---|---|
| Windows 10/11 | ✅ 支持 | 按 Strata 官方 `START-HERE.bat` / `SETUP.bat` / `UPDATE.bat` 的行为实现。**未实测**（开发机是 Linux），Windows 分支已按跨平台 API 编写，并在源码注释里逐处标注 `UNTESTED on Windows` |
| Linux | ✅ 支持 | 主力测试平台，功能完整（回归重点） |
| macOS | ❌ 不支持 | Strata 官方全文档零提及。插件在 `getStatus(ctx, opts)` 最前面判断 `process.platform === "darwin"`，直接返回 `state: "unsupported"`；widget 只渲染一条提示，隐藏所有操作按钮、配置表单和参数编辑 |

### 跨平台实现要点

新增 `lib/process.js` 统一收拢进程相关逻辑：

- **进程列举**：Linux 用 `pgrep -f` + `/proc/<pid>/cmdline`；Windows 用 PowerShell `Get-CimInstance Win32_Process`（`wmic` 在新 Windows 已弃用）。全部通过 `execFileSync(cmd, [args])` 的参数数组调用，**绝不拼接 shell 字符串**。
- **杀进程**：统一走 Node 原生 `process.kill(pid, signal)`（Windows 上映射为 `TerminateProcess`）；`process.kill(pid, 0)` 做存活检测。
- **Python 探测**（`lib/python.js`）：Windows 走 PATH 找 `python.exe` / `python3.exe` / `py.exe`；Linux 先固定路径（`/usr/bin/python3` 等）再走 PATH。
- **更新命令**（`routes/update.js`）：统一 `spawn(python, [path.join(strataDir, "setup.py"), "--update", ...])`，Windows/Linux 同一套代码。更新前检测 `git` 是否可用，不可用直接报“未找到 git，无法更新”。
- **CUDA 探测**：Windows 下兼容 conda 的 `<env>/Library/bin/nvcc.exe`、`<env>/bin/nvcc.exe`，以及系统 `C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\*\bin\nvcc.exe`（未实测）。
- **配置/数据目录**：Linux 用 `$XDG_CONFIG_HOME` / `~/.config/strata/settings.json`；Windows 用 `%APPDATA%` / `%LOCALAPPDATA%`（未实测）。
- **网络探测**：`ss -tln`（Linux）/ `netstat -ano -p TCP`（Windows）；本机 IP 在 Windows 上用 `os.networkInterfaces()`。

### 测试平台分支

`getStatus(ctx, { platform })` 与各 process helper 都接受可选的 `platform` 参数，测试时可在 Linux 上传 `"darwin"` / `"win32"` 验证分支，生产调用省略即用 `process.platform`。
