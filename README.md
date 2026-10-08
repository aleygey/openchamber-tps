# OpenChamber TPS Meter — 带密码实例修复版

版本：**1.1.1-auth.1**。这是用于实际环境验证的修复分支，不是上游官方发布版。

基于 `herbkk/openchamber-tps` 的 `feature/status-section` 紧凑版行为和统计逻辑，保留 Work Status 小卡片与完整 TPS 面板，并增加 UI 密码认证。运行时代码已整理为无需第三方运行依赖的 JavaScript；这不是原仓库的逐文件镜像，也不是只有一行改动的补丁。上游来源和许可证见 `docs/PROVENANCE.md`。

## 修复的问题

原版统计服务没有主界面的登录 Cookie，直接请求 `/api/global/event`，因此带 UI 密码的实例会返回 HTTP 401。本版不关闭服务器认证，也不读取主程序的秘密文件、Cookie 数据库、模型 API Key 或密码环境变量。

收到 401 后，小卡片显示登录入口。用户输入**已有的 OpenChamber 访问密码**，扩展服务通过官方 `POST /auth/session` 登录，获得 UI session Cookie 后订阅全局事件流。页面通过 OpenChamber 的 `serviceRequest` 通道请求扩展服务，不直接连接服务端口。

密码不写入磁盘、日志、浏览器存储或仓库；提交后清空输入框。会话 Cookie 只保存在扩展服务进程内存里，不返回给前端。JavaScript 使用垃圾回收，不能保证字符串在内存中即时物理擦除。

## 适用环境

- 目标接口：OpenChamber **2.1.1**，OpenCode 2 的全局事件流。
- 适用于 Windows 桌面前端直接连接 Linux OpenChamber Server 的部署；也保留 HTTP(S) 网页模式。
- 使用主程序提供的 Node 运行时；开发检查在 Node **22.16.0** 完成。
- 使用 UI 密码进行登录。不支持以此替代单点登录、仅客户端凭证认证或公共中继认证。
- ZIP 内的 `.js` 可以直接运行，**安装不需要 npm install、Bun 或重新编译 OpenChamber**。

## 直接通过扩展 URL 安装

在 Windows OpenChamber 中保持连接到目标 Linux 实例，打开 **Settings → Extensions**，移除旧的 TPS Meter，然后在 **Folder, ZIP, or URL** 中粘贴：

```text
https://github.com/aleygey/openchamber-tps#fix/ui-password-auth
```

点击 **Add**，审阅并批准运行本地服务权限。此分支与原版共用 `tps-meter` ID，不要并装。**保留 `#fix/ui-password-auth` 后缀**；仓库 `main` 没有本次修复。

回到 **Work Status → TPS**，首次提示登录时输入服务器已有的 OpenChamber UI 访问密码。无需关闭服务器密码，也无需重新编译或安装依赖。完整 TPS 面板标题显示版本 `1.1.1-auth.1`。

Git URL 安装跟随指定分支；之后的版本可通过扩展设置检查更新。远程实例需要由运行 OpenChamber Server 的机器正常访问 GitHub。

### GitHub 无法访问时：本地文件夹安装

将之前提供的 ZIP 上传到 Linux 并解压，或在能访问 GitHub 的机器克隆这个分支后复制到 Linux。在扩展页面填入 **Linux 上扩展根目录的绝对路径**（该目录下应直接包含 `package.json`），而不是 Windows 路径。

```bash
git clone --branch fix/ui-password-auth --single-branch \
  https://github.com/aleygey/openchamber-tps.git \
  "$HOME/openchamber-tps-auth"
realpath "$HOME/openchamber-tps-auth"
```

文件夹安装不自动更新；更新时先在扩展设置中停用，再更新目录并重新启用，避免进程与磁盘文件版本不一致。

## 首次登录

这里输入的是服务器启动参数 `--ui-password` 对应的**现有密码**，不是 Linux 登录密码、GitHub Token 或模型 API Key。无需将密码发给任何人。

页面会显示即将登录的服务器地址。若地址为 `http://...`，必须勾选确认：HTTP 不加密。只在确认可信的网络与正确服务器地址上使用；其他场景应使用 HTTPS 或经批准的安全隧道。扩展不会偷偷改为跳过 TLS 验证。

登录成功后，小卡片收回为默认 **64px** 高度。生成文本时显示 `≈ ... tok/s`；无输出时为 0；连接失败或未登录时显示 `—`，而不是伪装成真实零速率。完整 TPS 面板有“重试”“清除 TPS 登录”按钮。

在同一服务器内切换会话不会要求重复输入密码。扩展服务重启、切换服务器、清除登录，或重连时发现会话失效，可能需要重新登录。清除 TPS 登录只清除扩展自己的内存状态，不注销主程序。

## 安全边界

- 扩展服务仅监听 `127.0.0.1`；每个入口都检查主程序为该服务分配的 Bearer Token。
- 密码只用于显式的一次登录。失败不会自动重试密码；429 遵守 Retry-After。
- Cookie 绑定准确的 scheme + host + port；切换服务器清除旧凭据。
- 登录与事件流均禁止自动跟随重定向，不把密码或 Cookie 转发到重定向目标。
- 收到 401 后暂停事件流自动重试，等待用户登录。
- 不增加监听公网端口，不修改 OpenChamber 配置，不关闭访问密码。
- 仍然需要信任这个扩展：获准的本地扩展服务具有运行用户的系统权限。这个包的实现只使用所需的本地服务/网络能力，但不是操作系统沙箱。

## TPS 口径和限制

实时数值仍是**最近 5 秒文本字符数的校准估算**，不是 tokenizer 逐 token 计数。默认使用每字符 0.25 Token，再根据步骤结束的 `tokens.output + tokens.reasoning` 逐步校准。中文、代码、不同模型的分词方式会造成偏差，特别是在第一轮尚未结算之前。

本版统计文字与推理增量，不统计工具输入 JSON。完成轮次的平均速率使用已结算的 Token 数，时间仍由流式片段间隔估算；大于 1 秒的停顿及明确的用户等待不计入生成时间。这个值不是供应商服务器内测的解码 TPS，也不代表整个任务耗时。

继承的限制：一个服务进程跟踪一个活动会话；不同窗口同时选择不同会话可能互相切换统计目标。折叠状态区或关闭右栏会卸载页面。公共 Relay 的 `srcDoc` 页面没有可靠的 HTTP origin，本版没有新增 Relay 支持。通过改变外部端口或 Cookie 名的复杂反向代理也未实机验证。

## 开发与测试

所有运行时代码都是源码 JavaScript，无需打包器：

```bash
npm run check
npm test
```

`tests/` 使用本机假服务器、虚构密码和合成事件，不连接真实模型，也不读取用户项目。测试范围和真实环境尚未验证的部分见 `TEST-REPORT.md`。

`tests/ui_offline_check.py` 是可选的离线浏览器检查，需要 Python Playwright 和 Chromium。它在无 `allow-forms` 的 iframe 中测试点击登录、回车、布局等；使用模拟主程序及测试用 origin，不能替代真实 OpenChamber 兼容性验证。

## 许可证

MIT。原 TPS Meter 版权见 `LICENSE`；SDK 协议适配部分的上游版权见 `licenses/openchamber-sdk-LICENSE`。
