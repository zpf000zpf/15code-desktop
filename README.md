# 15code Desktop

## PPT Studio

PPT Studio follows a staged workflow: generate an editable outline, revise it, use the same
15code `gpt-image-2` image service to create or redo individual slide visuals, run a lightweight
quality check, then export an editable PPTX. It does not use a separate image provider or a manual
PPT image billing path; normal image permission, reservation, failure-release and Usage rules apply.

> **15code 桌面客户端 v1.0.12** — 无需 API key，登录即用
> Windows · macOS · Linux 跨平台 · 由 [15code](https://15code.com) 出品

![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)

## ✨ 这是什么

用过 Chatbox / CherryStudio？它们都要你自己填 API key、配 endpoint、选模型，对普通用户门槛太高。

**15code Desktop 是一个"登录即用"的大模型桌面客户端**：

- 📧 **邮箱 + 密码登录**（用你 15code 账户）
- 💬 **聊天**：流式响应 · Markdown 渲染 · 代码高亮
- 📎 **附件**：拖入任意文本文件（txt/md/json/csv/源码）→ 自动读入
- 📥 **导出**：一键导出整个对话为 Markdown
- 🤖 **8 个模型**：Claude Opus/Sonnet/Haiku · GPT-5.4 · GPT-5.3 Codex Spark · GLM-5/5.1
- ⌨️ **快捷键**：`Ctrl+Enter` 发送 · `Ctrl+N` 新对话 · `Ctrl+O` 导入文件

## 📥 下载

### Windows

👉 **[从 Releases 下载 .exe 安装包](https://github.com/zpf000zpf/15code-desktop/releases/latest)**

安装后在开始菜单找"15code"打开 → 用 15code 账户登录即可。

v1.0.13 当前按未签名 Beta 发布，安装时 Windows 可能显示“未知发布者”或 SmartScreen 提示。请从官方 Release 下载并核对随安装包发布的 SHA256 文件。取得 Authenticode 证书后将切换为正式签名安装包。

### macOS / Linux（构建中）

```bash
# 克隆源码自行运行
git clone https://github.com/zpf000zpf/15code-desktop.git
cd 15code-desktop
npm install
npm start
```

## 🚀 快速开始

1. **下载安装**
2. **登录**：用 [15code.com](https://15code.com) 注册的邮箱 + 密码
3. **选模型**：顶部下拉 · Claude / GPT / GLM 任选
4. **开聊**：输入问题 → `Ctrl+Enter` 发送

不用填 API key、不用配 base_url、不用管 endpoint，全部在登录时自动处理。

## 🛠️ 技术栈

- **Electron 43** + 纯 HTML/JS（无前端框架）
- 登录：15code Bearer Session，使用 Electron `safeStorage` 加密保存
- API Key：仅在 Electron 主进程使用 `safeStorage` 加密保存，渲染层不可读取
- 会话：SQLite 持久化，支持搜索、置顶、重命名、删除、恢复和草稿
- 模型与升级：读取公共 Catalog，支持离线目录、维护状态和最低版本策略
- 聊天：流式 SSE 调用 15code 搜索聊天接口，支持主动停止
- 无本地数据库（v1.0 会话在内存里；关闭 = 清空）

## 📸 截图

*（待补）*

## 🗺️ 路线图

### v1.0（当前）✅
- 登录 / 聊天 / 模型选择 / 文件附件 / 导出

### v1.1（计划中）
- [ ] 对话历史（本地 SQLite 持久化）
- [ ] 多会话标签
- [ ] 图片支持（Claude / GPT vision）
- [ ] 浅色主题

### v1.2
- [ ] macOS / Linux 官方包签名
- [ ] 会话云同步（Pro 会员）
- [ ] PDF / Word 附件自动解析

## 🤝 贡献

Bug 报告 / 功能建议 → [Issues](https://github.com/zpf000zpf/15code-desktop/issues)

## 📜 License

Apache 2.0

---

**Made with ❤️ by [15code](https://15code.com)**
