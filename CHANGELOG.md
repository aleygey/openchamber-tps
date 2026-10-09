## 1.2.1 — 2026-10-09

- 修复活跃统计仍取自固定五秒墙钟窗口，导致长工具调用前后短输出 TPS 偏低的问题。
- 实时、会话平均、峰值、曲线、上一轮平均统一使用匹配的生成增量和实测区间；短窗口按实测时长归一化。
- 区分生成工具参数与运行工具；等待时显示状态而非补零，支持后台工具与模型并行输出。
- 首片段只建锚点，低于250ms不展示窗口速率；明确边界断开，未标注的慢速间隔不再按一秒阈值删除。
- 新口径写入 metrics-v2，旧 metrics-v1 保留而不混入；断线/重连和重置明确切断计时。
- 同步更新测试口径，补充长达五分钟工具等待不影响速度的回归测试。认证逻辑未改。

# Changelog

## 1.2.0 — 2026-10-09

- Add per-session active-time-weighted average and highest observed rolling-5s TPS.
- Add compact/full SVG activity charts, 60s/5m/retained-history windows, pause boundaries, hover timestamps and a fold control.
- Persist numeric-only records by hashed server/session key; private atomic writes every 5 seconds; restore after service restart.
- Retain up to 100 sessions and 1800 points per session; lifetime average/peak survive history trimming.
- Keep one global SSE connection across session changes and continue collecting previously opened sessions on the same server.
- Add authenticated history/reset endpoints, explicit per-session reads and a two-click reset that does not clear login or other sessions.
- Preserve the working UI-password authentication; recover watches after extension service restart.
- Add statistics/persistence/service tests and expand sandboxed UI checks. All figures remain observed estimates; no retrospective TPS reconstruction.

## 1.1.1-auth.1 — 认证修复版

为带 UI 密码的 OpenChamber 2.1.1 增加显式登录，使用 `/auth/session` 返回的 Cookie 订阅全局 SSE。原先的紧凑 Work Status 布局仍然保留。

安全相关：仅内存 Cookie、准确 origin 绑定、不跟随重定向、不自动重试密码、429 退避、每个扩展服务入口保留 Bearer 验证、HTTP 登录显式确认。

界面相关：认证前显示“需要登录”；无连接时显示 `—`；登录后恢复 64px 卡片；增加中文文案；使用 SDK 请求而不是被沙箱禁止的表单提交。

统计逻辑相关：从原服务抽出可测试的计数模块，保留字符估算口径，增加 SSE 分片与重复结算测试。此包不宣称提高 tokenizer 准确率，也未加入公共 Relay 支持。
