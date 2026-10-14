# 路线图 / 待办

版本规划：
- **1.0.0**：v2 App 首发，本地源码部署
- **1.1.0**（当前）：本机 / Docker 双模式，用户显式二选一
- **1.1.1**（下一版）：AMD / 社区镜像支持

## 1.1.0：本机 / Docker 双模式

> **状态：已定稿实现（1.1.0）。** 实现记录见
> [`v1.1-docker-notes.md`](./v1.1-docker-notes.md)。`lib/deployer/` 抽出
> local + docker 两个实现与统一门面。
>
> 定稿语义（覆盖早期 `auto` 设计）：`deployMode ∈ {local, docker}`，**无
> auto、无自动切换**；首次只看镜像给默认并持久化；两模式互斥，切换先停旧并
> 弹确认；Docker 以镜像为锚，App 用采样的 run 参数创建/重建容器；
> `routes/update.js` 在 docker 模式转发到 `DockerDeployer.update()`；
> **Docker 模式仅 Linux**。
>
> **第二批（首次启动）已实现**：配置页从「选已有配置文件」改成「指定
> GGUF 模型目录」；没有可用配置时，同一个启动按钮先跑 setup 生成配置再
> 起服务（本机 `setup.py --setup --gguf-dir … --no-start`；Docker 用
> `GGUF_DIR` + `STRATA_DATA` 首启）；首次启动进度分四段
> （下载 → 转换 → 生成配置 → 加载）。实现记录见
> [`v1.1-firstrun-notes.md`](./v1.1-firstrun-notes.md)。已有配置路径零回归。

**背景**：Strata 官方支持 Docker 部署（仓库根有 `Dockerfile` + `docker-entrypoint.sh`，
文档在 `docs/INSTALL.md`）。当前版本（1.0.0）**只支持本地源码部署**。

**Docker 部署的差异**（插件需要适配的点）：

| 维度 | 本地源码部署（当前支持）| Docker 部署（待支持）|
|---|---|---|
| 服务进程 | 本机 `python serve/server.py` | 容器内 |
| 启停 | `pgrep` / `kill` | `docker start` / `docker stop` |
| 配置 | `strata-iq3_s.json` | 容器环境变量（`MODEL`/`CONTEXT`/`HOST`/`PORT`/`API_KEY`/`KV`/`GPUS`…）|
| 监控 | `nvidia-smi` | `docker stats`（或宿主 nvidia-smi）|
| 数据 | `<strataDir>/Strata-data` | 容器 volume（如 `/data`）|

**要做的**：
1. 检测部署方式（有容器在跑 = Docker；有本地进程 = 源码）
2. Docker 模式下：
   - 启停走 `docker`
   - 配置读取改为读容器环境变量（`docker inspect`）
   - 版本检查改看容器镜像 tag
   - 更新改为拉新镜像 + 重建容器
3. manifest 可能需要加 `docker` 相关配置项（容器名、compose 文件路径）

**接口不变的部分**：状态查询仍走 `/v1/status`（HTTP API 一致）。

## 1.1.1：AMD / 社区镜像

1.1.0 只做**官方路径**（官方 Dockerfile，CUDA/NVIDIA）。以下整体留给 1.1.1：

- 按 AMD 型号自适应社区镜像：MI50 有现成 `xxdoman/strata-mi50:latest`；
  RX 7900 XTX / 9060 XT / 9070 XT 只有 ROCm 基座，需自建。
- 「使用社区镜像」勾选 + 免责声明 + 拉取选项（**仅手动选 Docker 时出现**）。
- 检测到**整机所有卡都不被 Strata 支持**（如纯 MI50）时置灰「本机」模式。
- 内置「Strata 支持的 GPU 型号」列表（源：`Strata/docs/INSTALL.md:16`）。

## 其他待办

- **页面导航**（用户反馈）：整页（page）最好加一个**后退/返回按钮**，点一下回上一状态（比如从控制台退回聊天）。下一版优化交互时一起做。
- **截图**：README 可选的界面截图（非市场必需）
- **性能优化**：`lib/fsx.js` 用 POSIX 命令绕 v2 沙箱；若官方开放同步 fs API 可简化
