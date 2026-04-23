# 桌面端账号互通排查（2026-04-23，含活机核验）

## 真相（SSH 到 52.221.32.208 已确认）
- `15code.com` 和 `new.15code.com` 在同一个 nginx 块里，同一个上游 `127.0.0.1:3000`，
  跑的是同一份 `15code-platform` 代码、同一个 Postgres、同一张用户表。
- **账号已经是互通的**。之前以为有"新老两套用户库"是误判，作废。
- 线上真正的登录路径是 `POST /api/auth/login`，不是 `/api/login`。

## 桌面端真正的 bug
| 文件 | 行 | 现状 | 实际 |
| --- | --- | --- | --- |
| src/index.html | 453 | `const PLATFORM = 'https://new.15code.com';` | 应为 `https://15code.com`（主账号域，别锁临时子域） |
| src/index.html | 518 | `POST PLATFORM + '/api/login'` | 404；应为 `/api/auth/login` |
| src/index.html | 557 | `POST PLATFORM + '/api/logout'` | 404；应为 `/api/auth/logout` |

## 桌面端本来就对的（上一版错判为"要改"，实际不动）
- src/index.html 399：注册跳 `https://15code.com/login?mode=register` ✅
- src/index.html 401：忘记密码跳 `https://15code.com/forgot-password` ✅
- src/main.js 101/102/112：菜单"主站 / 使用文档 / About"指 15code.com ✅
- README 里 "用 15code.com 注册的邮箱" ✅

## CSP 需要同步调整
`src/index.html:6` CSP 的 `connect-src` 现有：
`https://new.15code.com https://claude.15code.com https://15code.com`
改 PLATFORM 后 `15code.com` 还在，不用动；可把 `new.15code.com` 去掉，
保守起见先留着（有些用户可能 DNS 缓存在临时子域）。

## 下一步
等用户确认后按上表改 3 行，然后本地跑一遍 `npm start` 验证登录流。
