# 测试报告

交付版本：`1.1.1-auth.1`；提交分支：`fix/ui-password-auth`。

2026-10-08：提交前重新运行语法/资源检查、19 项 Node 测试和离线浏览器检查，全部通过。原始输出见 `docs/node-test-results.txt` 与 `docs/ui-test-results.txt`。

## 通过的检查

环境：Linux，Node.js `v22.16.0`。测试使用随机本地端口与虚构密码，不连接真实 OpenChamber、模型供应商或用户项目。

`npm run check`：通过。检查 manifest 引用、所有运行/测试 JS 的语法、浏览器经典脚本引用与本地资源完整性；确认登录不依赖 iframe 中不可用的浏览器 `<form>` 提交。

`npm test`：**19/19 通过，0 失败，0 跳过**。

覆盖范围：

- 官方密码登录请求形状：`POST /auth/session`、`password`、`trustDevice:false`。
- 接收正确端口的 UI session Cookie，仅内存持有，不输出到 rate 响应或服务日志。
- 密码错误不自动重试；429 限流阻止重复登录。
- 切换 origin 时取消未完成登录，清除旧 Cookie；不跨 origin 发送凭据。
- 不跟随登录或事件流重定向。
- 401 → 手动登录 → 携带 Cookie 的真实本地 HTTP/SSE 连接 → 统计有输出数值。
- 收到 401 后暂停事件流自动重连；撤销会话后的重连返回登录状态。
- 原来无密码的服务器仍可工作，但本版不会自动关闭服务器密码。
- 扩展服务 `/health`、`/rate` 和登录入口均要求服务 Bearer Token。
- 明确的 HTTP 登录确认、同服务器切换会话复用登录、清除登录。
- 文本/推理计数、会话过滤、工具输入不计数、完整快照不重复计数。
- 真实步骤 Token 结算、重复结算、等待与长停顿的处理。
- SSE 字节分片、CRLF、Unicode、多行 data、损坏/过大帧。
- OpenChamber SDK v1 消息形状与来源校验，包括 `resize`。

## 浏览器界面检查

通过 Python Playwright + 系统 Chromium 的**离线沙箱 iframe**检查。使用 `sandbox="allow-scripts"`，没有添加 `allow-forms` 或 `allow-same-origin`。

检查了：中文认证提示、HTTP 未确认时拒绝登录、点击登录、密码字段清空、成功后收回 64px、实时数字、会话切换、完整面板、清除登录、错误密码提示、回车重新登录。没有未捕获 JavaScript 错误。

这些检查使用测试版主程序消息应答；因为离线 srcDoc 没有 HTTP origin，测试在内存中注入固定的 `http://fixture.test:3000` origin。**该替换不在交付运行时代码中**。浏览器 UI 测试和本地 HTTP/SSE 服务测试是两个独立层次，不应合称真实 OpenChamber 端到端验证。

## 仍待实机验证

尚未在用户的 Windows OpenChamber 2.1.1 + Linux 云桌面实例中实际安装测试。真实主程序的扩展安装、资源 CSP、主程序代理/认证策略、具体模型的事件内容与网络条件，还需要加载后验证。源码接口核对和上述仿真测试不能保证这些环境全部一致。

未验证公共 Relay、企业单点登录、仅客户端证书/凭证认证、自定义 Cookie 名、外部端口与内部端口不同的反向代理，以及多窗口同时选择不同会话。

本次修复使用独立分支，保留 `main` 不变。远程仓库中的完整代码、测试和本报告一起提交；未将仿真验证描述为用户机器实测。
