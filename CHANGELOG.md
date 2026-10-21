# Changelog

All notable changes to this project will be documented in this file.

## [0.9.0] - 2026-10-21

### Added
- **智能感知系统 (`lib/sense.js`, `lib/sense-win.js`, `lib/sense-phone.js`)**：
  - 在 60 秒节律中采样系统空闲、前台窗口与最新消息活跃度。
  - 状态判定与双采样去抖：`present`（活跃）、`nearby`（附近）、`away`（离开）、`asleep`（安静时段）。
  - 原子写入 `sense.json`，追加环形 500 行 `sense.log`。
  - Windows 环境基于 PowerShell P/Invoke 采样；手机端基于 3090 设备桥与 adb-shell 采样。
- **主动开口触发机制 (`lib/trigger.js`)**：
  - `returned` 事件：用户离开后回来主动触发 `agent.followup` 由模型决定开口内容。
  - 会话路由精准定位：按 session 文件最新 `mtime` 定位用户正在查看的活跃窗口，找不到或并列时静默等待，绝不盲投退回 `list()[0]`。
  - 触发状态与冷却记录于 `trigger.json`，默认 360 分钟冷却；安静时段（23:00–08:00）静默。
- **CLI 与工具**：
  - 新增独立命令行工具 `node bin/sense.js`，无 DSH 依赖，即跑即出采样 JSON。
  - 新增工具 `heart_sense`，供随时查看当前感知状态。
  - 面板状态路由 `/api/dsh-heart/state` 增加 `sense` 与 `trigger` 字段。
