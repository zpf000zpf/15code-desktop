# 15code-desktop 项目级上下文（Claude 必读）

> 每次开工前扫一眼本文件，避免重复之前犯过的逻辑错误。

## 地基事实（2026-04-23 SSH 活机核实）

- **账号系统只有一套**：`15code.com` / `www.15code.com` / `new.15code.com`
  在 nginx 上是同一个 server 块，都反代到同一个 `127.0.0.1:3000`，
  跑的是 `/opt/15code/platform`（`15code-platform.service`，Node + Postgres）。
  **不存在"新/老两套用户库"**。
- **`15code.com` 是主账号域**。`new.15code.com` 只是临时子域，
  桌面端 / 文档里一律写 `https://15code.com`，**不要**把 `new.15code.com` 硬编码进客户端。
- 线上真实 API 路径（curl 实测）：
  - `POST /api/auth/login`    ✅（挂在 `app.use('/api/auth', routes/auth)`）
  - `POST /api/auth/logout`   ✅
  - `POST /api/auth/register` ✅
  - `POST /api/auth/forgot-password` ✅
  - `GET  /api/me`            ✅（挂在 `app.use('/api', routes/me)`）
  - `GET  /api/tokens`        ✅（挂在 `app.use('/api/tokens', routes/tokens)`）
  - `GET  /api/pricing`       ✅（挂在 `app.use('/api', routes/pricing)`）
  - `/api/login`、`/api/logout` 都是 **404**，别用。

## SSH
- `ssh 15code-api` → `ubuntu@52.221.32.208` (`~/.ssh/api.pem`)，已写入 `~/.ssh/config`。
- 相关服务：
  - `15code-platform.service`（membership + billing，Node，port 3000）
  - `cli-proxy-api.service`（LLM 转发层，port 8787）
  - `15code-verify.service`（FastAPI，port 8000）
- nginx 站点配置在 `/etc/nginx/sites-enabled/`：
  `15code-main.conf`、`claude-proxy.conf`、`cn-15code.conf`、`verify-15code.conf`。

## 桌面端与后端的当前不匹配

`src/index.html` 里：
- `PLATFORM` 写的是 `https://new.15code.com`，应改为 `https://15code.com`。
- 登录调 `/api/login`（404），应改为 `/api/auth/login`。
- 登出调 `/api/logout`（404），应改为 `/api/auth/logout`。
- 注册 / 忘记密码的跳转链接 `https://15code.com/login?mode=register`、
  `https://15code.com/forgot-password` —— **这两条是对的**，别去乱改成 `new.` 子域。

## 仓库对照表
- `/home/zpf000zpf/15code-workspace/new-platform` == 线上 `/opt/15code/platform` 的源码镜像，
  都是 PG + Node + JWT cookie session，**不是**"新老两套"里的"新"，
  是**唯一一套**。
- `/home/zpf000zpf/15code-workspace/current-api-platform` 是已废弃的 SQLite 老实现，
  **线上已经不跑了**，排查时不要再拿它当参照系。

## Claude 的纪律（针对本项目）
1. 看到 "new.15code.com" 不要下意识当成"新平台"。它只是 DNS alias。
2. 讨论账号/登录问题之前，先 `ssh 15code-api` 看 nginx + systemd，
   而不是只读本地仓库猜线上。
3. 改桌面端前端的后端地址和路径前，先在活机 `curl` 一遍确认 HTTP 状态。
