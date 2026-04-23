# 15code Desktop

> **15code 桌面客户端 v1.0** — 无需 API key，登录即用  
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
- 🤖 **8 个模型**：Claude Opus/Sonnet/Haiku · GPT-5.4 · GPT-5.3 Codex · GLM-5/5.1
- ⌨️ **快捷键**：`Ctrl+Enter` 发送 · `Ctrl+N` 新对话 · `Ctrl+O` 导入文件

## 📥 下载

### Windows

👉 **[从 Releases 下载 .exe 安装包](https://github.com/zpf000zpf/15code-desktop/releases/latest)**

安装后在开始菜单找"15code"打开 → 用 15code 账户登录即可。

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

- **Electron 32** + 纯 HTML/JS（无前端框架，代码总量 ~900 行）
- 登录：`POST new.15code.com/api/login`（cookie session）
- 聊天：流式 SSE 调用 `claude.15code.com/v1/chat/completions`
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
