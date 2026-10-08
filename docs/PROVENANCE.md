# 来源与实现范围

## TPS 上游

- 原项目：https://github.com/airtaxi/openchamber-tps
- 紧凑版来源：https://github.com/herbkk/openchamber-tps/tree/feature/status-section
- 所检查的 manifest 版本：1.1.0
- 上游 `package.json` blob：`4e0b1f4583c33596a414fff5736f68383a465399`
- 上游 `service/main.ts` blob：`5033d8ebc162da7436488b888a1b57820a9791ef`
- 上游 `status/main.ts` blob：`96174890c64623939f1d2095c2eb76c4d6fdd675`

这些是文件 blob SHA，不是完整仓库 commit SHA。本包不是完整 Git 历史，也没有伪造上游提交信息。服务统计逻辑沿用并重构上游实现；新增独立认证模块、SSE 解析器测试、登录界面和测试用例。

## 主程序接口

以 OpenChamber `v2.1.1` 为核对版本：

- `packages/web/server/lib/ui-auth/ui-auth.js`：密码登录创建 UI session；不是 HTTP Basic Auth。
- `packages/web/server/lib/ui-auth/session-cookie.js`：`oc_ui_session` 与 `oc_ui_session_<port>` 命名。
- `packages/web/server/lib/opencode/core-routes.js`：`POST /auth/session`。
- `packages/sdk/GUEST_SERVICES.md`：扩展服务环境变量隔离、主程序代理与 Bearer 校验。
- `packages/sdk/src/api-version.ts`、`host.ts`：`openchamber.sdk` / v1 的 `hello`、`ready`、`session`、`result`、`service-request`、`resize`。
- `packages/sdk/src/ui/theme.ts`：主题 token 映射。

主程序仓库：https://github.com/openchamber/openchamber/tree/v2.1.1

`ui/host-bridge.js` 是这些已核对消息接口的最小适配实现，不是完整 `@openchamber/sdk` 分发包；未冒充官方 SDK。

## 相对原紧凑版的主要改动

- 新增一次性密码登录入口与内存中的 UI session Cookie，保持服务器访问认证。
- 对认证失败、限流、取消、不同服务器切换和重定向明确处理。
- 保持 64px 状态卡片；登录时临时展开，完成后收回。
- 由于 iframe 不提供 `allow-forms`，登录使用普通按钮和 SDK 服务请求，不依赖浏览器表单提交。
- 原统计变量名 `charsPerToken` 实际表示 Token/字符；为了服务数据兼容保留字段名，界面改用正确说明。
- SSE 解析支持分片 CRLF 与 Unicode；重复步骤结算不重复累计或重复校准。
- 运行时代码整理为无需安装依赖的 JS 模块与经典浏览器脚本，源代码随包附带。
