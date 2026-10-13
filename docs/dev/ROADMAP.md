# 路线图 / 待办

## 下一版：Docker 部署支持

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

## 其他待办

- **截图**：README 可选的界面截图（非市场必需）
- **性能优化**：`lib/fsx.js` 用 POSIX 命令绕 v2 沙箱；若官方开放同步 fs API 可简化
