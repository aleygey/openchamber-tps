# 1.3.0 测试报告

目标分支：`fix/ui-password-auth`。基线提交：`e99ef9e75af29063ac98ac3a37ca0271154a4224`。

## 实际执行

Linux、Node.js v22.16.0、Python Playwright、系统Chromium。

- `npm run check`：通过，JavaScript语法、manifest、经典脚本、HTML/CSS资源检查。
- 定向Node命令：`node --test tests/auth.test.mjs tests/bridge.test.mjs tests/presentation.test.mjs tests/minimal-service.test.mjs`，**23通过、0失败、0跳过**。其中14项为本版新增测试，9项为原认证/SDK回归。本报告不将未重新执行的其余旧测试算入通过数量。
- `python tests/ui_offline_check.py`：通过，使用 `sandbox="allow-scripts"` 的离线主程序替身。

原始输出：`docs/minimal-node-test-results.txt`、`docs/minimal-ui-test-results.txt`、`docs/minimal-check-results.txt`。

## 重点验证

250ms重采样、EMA平滑有界、短边界连接、1.2–2.5秒淡虚线、长暂停断线、不向等待补零、不修改历史原对象、长历史点数上限。

数值只按新测量更新，不按轮询次数漂移；同一数据过期后显示等待，工具/认证/断线立即隐藏当前TPS。切换会话、重置和时钟回退不继承错误的平滑状态。

五分钟工具运行及大量工具日志不改变原始生成平均、峰值、计时时长；未标注的三秒慢速流间隔保守保留，不使用短间隔阈值删除。现有metrics-v2记录不被显示操作修改。

真实本地HTTP/SSE模拟登录、Cookie认证、服务Bearer校验、工具阶段的暂停显示、持久化只含数值且无测试密码/Cookie泄露。

浏览器检查：中文HTTP确认、错误密码、回车登录、密码字段清空、260/340/480px宽度无横向溢出、默认90–125px高度、默认只有数值/tok/s/曲线/状态点与详情按钮；详情、范围、悬停、明暗主题、工具期间图与累计统计保持、会话切换、二次确认重置、完整面板。没有未捕获JavaScript错误。

## 发布边界

计量模块 `service/generation.js`、`meter.js`、`statistics.js`、认证模块和SDK桥接保持基线内容；发布前用Git blob SHA核对。`service/main.js`仅更新health版本字符串。

统计口径未迁移，仍为metrics-v2；新显示点不会回写测量数据。阈值不会删掉未标注的慢速生成时间。

本次未在用户的Windows OpenChamber 2.1.1与Linux云桌面上实际安装；UI用离线沙箱与合成图点，HTTP测试使用模拟事件源，不能合称真实OpenChamber端到端测试。截图仅为合成数据，不代表任何模型速度。

## 本次仓库提交

在用户要求改用 GitHub 更新后，重新执行 `npm run check`、23 项定向 Node 测试和离线浏览器检查，均通过。沿用 `fix/ui-password-auth` 分支，保留 `main` 和原有测试文件，不提交任何用户截图、项目文件或登录凭据。

同时补充完整面板的空值保护：工具运行或样本不足时 `charsPerSecond` / 上一轮 TPS 可能为 null，显示 `—`，不调用 null.toFixed()。离线检查增加了完整面板在工具阶段的覆盖。除此之外，运行代码沿用已交付的 1.3.0 极简版；更新说明改为 Git URL 安装。

基线的原始计量和认证模块通过 Git blob SHA 对照保持不变。这里的测试不等同于用户机器实测。
