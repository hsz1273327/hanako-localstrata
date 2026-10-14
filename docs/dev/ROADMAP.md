# 路线图 / 待办

版本规划：
- **1.0.0**：v2 App 首发，本地源码部署
- **1.1.0**（当前）：多环境配置（profiles）——本机与容器统一管理
- **1.1.1**（下一版）：待定（AMD / 社区镜像通过自定义配置已可表达）

## 1.1.0：多环境配置（profiles）

> **状态：已定稿实现（第四批，`v1.1-TASK-4.md`）。** 实现记录见
> [`v1.1-profiles-notes.md`](./v1.1-profiles-notes.md)。
>
> 最终语义：docker 与本地统一抽象为「环境配置」`profiles`（`type: local |
> container`，各有独立字段），`activeProfileId` 记录当前/上次使用的配置。
> 配置页管理配置（列表 / 新建 / 编辑 / 删除；运行中禁改删；至少留一套；
> 第一套默认名 `default`）；停机页选一套启动；运行中显示当前配置名。
> 不再有 `deployMode` / `useMi50` / 入口分流 / 互斥切换 / 以镜像为锚的
> build/重建 / `routes/update.js` 的 docker 转发，也没有 MI50 特例。
>
> **首次启动保留**（本机：无配置时 `setup.py --setup --gguf-dir` 生成配置
> 再起服务；容器：`GGUF_DIR` + `STRATA_DATA` 首启由 entrypoint setup）。本机
> 扁平字段仍可作为第一套 `default` 配置的兜底，保证本机模式零回归。

**背景**：Strata 官方支持 Docker 部署（仓库根有 `Dockerfile` +
`docker-entrypoint.sh`，文档在 `docs/INSTALL.md`），也支持本机源码运行。
用「多套环境配置」而不是「互斥模式」来表达，这样 MI50、双卡、未来的官方
镜像、CUDA12 vs CUDA13 都只是不同的配置，不需要任何特例。

**实现方式**：`lib/profiles.js` 定义配置模型；`lib/deployer/index.js` 按
`activeProfile.type` 选用本机 / 容器部署器；`lib/deployer/docker.js` 是通用
容器部署器（不再有 MI50 配方）。启动/停止/配置读写/日志接口不变，状态查询
仍走 `/v1/status`，只是状态里多了当前配置信息。

## 1.1.1：待定

1.1.0 的 profiles 已经能表达 AMD / 社区镜像（直接建一套 `container` 配置，
填社区镜像与容器名）。后续若要做的，是让 App **自动发现/推荐**这类镜像和
内置「Strata 支持的 GPU 型号」列表等锦上添花的能力，而非新的部署模式。

## 其他待办

- **页面导航**（用户反馈）：整页（page）最好加一个**后退/返回按钮**，点一下回上一状态（比如从控制台退回聊天）。下一版优化交互时一起做。
- **截图**：README 可选的界面截图（非市场必需）
- **性能优化**：`lib/fsx.js` 用 POSIX 命令绕 v2 沙箱；若官方开放同步 fs API 可简化
