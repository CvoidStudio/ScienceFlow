# Lite / Heavy 模式切换与消息发送格式

## 概述

前端 CockPit 消息发送窗口提供 Lite / Heavy 两种任务模式。用户通过开关按钮切换模式后，发送的每条消息都会携带当前模式信息，经 Go 层注入到 query 中，最终通过 gateway_server 的 `POST /sessions/{id}/invoke` 端点启动智能体任务。

## 模式切换 UI

### 开关按钮

位于消息输入框（`front-composer`）工具栏中，`+` 上传按钮的右侧：

```
ChatRail.tsx → composer-tools
  ├── + (上传下拉)
  ├── mode-toggle 开关按钮
  └── 发送 / 停止按钮
```

- **Lite 模式**：滑块在左侧，cyan 色调（`#5cc8ff`），标签显示 `lite`
- **Heavy 模式**：滑块在右侧，orange 色调（`#ff9f6e`），标签显示 `heavy`
- 点击按钮在 lite ↔ heavy 之间切换
- Heavy 模式下 composer 背景渐变为暖棕色调，提供视觉提示

### 状态管理

```ts
// ChatRail.tsx
const [taskMode, setTaskMode] = useState<'lite' | 'heavy'>('lite');

const handleTaskModeSelect = (mode: 'lite' | 'heavy') => {
  setTaskMode(mode);
};
```

`taskMode` 是纯本地 React state，不涉及任何后端 API 调用。切换即时生效，下一次发送消息时使用新模式。

## 消息发送完整链路

```
用户点击发送按钮 / 按 Enter
  │
  ▼
ChatRail.handleSend()
  │  1. 读取 taskMode 状态（'lite' 或 'heavy'）
  │  2. 读取 chatSessionId（gateway session ID）
  │  3. 构造用户消息，添加到 chatMessages
  │
  ▼
gatewayInvokeAgent(token, sessionId, text, taskMode)
  │  gateway.ts → 构造 { query: text, mode: taskMode }
  │
  ▼
Wails 绑定: GatewayInvokeAgent(token, sessionId, { query, mode })
  │
  ▼
Go 层: App.GatewayInvokeAgent(token, sessionID, req)
  │  req = GatewayInvokeRequest { Query: text, Mode: "lite"|"heavy" }
  │
  │  ★ 关键步骤：将 mode 注入到 query 前缀
  │  if req.Mode != "" {
  │      body.Query = fmt.Sprintf("[mode=%s] %s", req.Mode, req.Query)
  │  }
  │
  │  最终 query 格式："[mode=lite] 帮我分析这份数据"
  │                  "[mode=heavy] 做一个完整的ML pipeline"
  │
  ▼
gatewayDo("POST", "/sessions/{id}/invoke", token, body)
  │  HTTP 请求：
  │    POST http://<gatewayURL>/sessions/<sessionId>/invoke
  │    Authorization: Bearer <token>
  │    Content-Type: application/json
  │
  │    Body: { "query": "[mode=lite] 帮我分析这份数据" }
  │
  ▼
gateway_server → 解析 mode（字段 > [mode=X] 前缀 > lite），启动对应类型任务
  │    lite → cli repl -m manifest；heavy → cli run --type lnr -t query
  │  返回 202 Accepted + GatewayTaskSnapshot（含 mode 字段）
  │
  ▼
Go 层返回 GatewayTaskSnapshot → 前端收到 task.id
  │
  ▼
ChatRail 添加平台消息: "Task started: <id> (status: <status>)"
  │
  ▼
SSE 流开始推送 agent 日志 → gateway-log 事件 → CockPit 工作流块
```

## 消息格式说明

### 前端到 Go 层（Wails 绑定）

```typescript
// gateway.ts
gatewayInvokeAgent(token, sessionId, query, mode)

// 实际调用：
GatewayInvokeAgent(token, sessionId, { query: text, mode: "lite" })
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `token` | string | gateway 登录 token |
| `sessionId` | string | gateway 会话 ID |
| `query` | string | 用户输入的原始文本（不含 mode 前缀） |
| `mode` | `'lite' \| 'heavy'` | 任务模式，空字符串等价于 lite |

### Go 层到 gateway_server（HTTP）

```go
// GatewayInvokeRequest 结构
type GatewayInvokeRequest struct {
    Query string `json:"query"`
    Mode  string `json:"mode,omitempty"` // "lite" | "heavy"
}
```

Go 层在发送前**将 mode 注入到 query 字符串前缀**：

| 前端传入 | Go 层处理后发送给 gateway |
|----------|--------------------------|
| `query="帮我分析数据"`, `mode="lite"` | `query="[mode=lite] 帮我分析数据"` |
| `query="做一个ML pipeline"`, `mode="heavy"` | `query="[mode=heavy] 做一个ML pipeline"` |
| `query="你好"`, `mode=""` | `query="你好"`（无前缀） |

**HTTP 请求**：

```
POST /sessions/<session_id>/invoke
Authorization: Bearer <token>
Content-Type: application/json

{
  "query": "[mode=lite] 帮我分析数据"
}
```

### gateway_server 响应

```
202 Accepted
Content-Type: application/json

{
  "id": "task-abc123",
  "status": "running",
  "mode": "lite",
  "workspace": "/data/sciflow_ws/admin/<session>/",
  "log_dir": "...",
  "started_at": "2026-09-04T10:00:00Z"
}
```

## gateway_server 的模式解析与任务类型映射

gateway_server 的 `POST /sessions/{id}/invoke` 接收请求后，按以下优先级解析任务模式，
并启动**对应类型**的智能体任务（内部实现见 `log_gateway_server/internal/server/server.go`
`handleInvokeAgent` 与 `internal/agent/runner.go`）：

| 优先级 | 来源 | 说明 |
|--------|------|------|
| 1 | JSON `mode` 字段 | 请求体可直接携带 `"mode": "lite" \| "heavy"`，显式声明优先 |
| 2 | query 前缀 | Go 层注入的 `[mode=lite]` / `[mode=heavy]` 前缀（正则 `^\[mode=([\w-]+)\]\s*`，大小写不敏感） |
| 3 | 缺省 | `lite` |

- 前缀/字段解析后从 query 中**剥离**，agent 收到的是干净的原始消息。
- 非法模式值（非 lite/heavy）返回 `400`。

### 模式 → 任务类型映射

| 模式 | 启动的 CLI 入口 | 命令形态 |
|------|----------------|----------|
| `lite`（默认） | `scienceflow.cli repl`（轻量交互式 REPL 求解） | `python -m scienceflow.cli repl -m <gateway_manifest.yaml> --auto-first-user --exit-after-auto --plain` |
| `heavy` | `scienceflow.cli run --type lnr`（长周期 LNR 完整流水线） | `python -m scienceflow.cli run --type lnr -t <query> -w <workspace/run> [-c <config>] [-d <input_data_dir>]` |

细节：

- **lite**：gateway 为每次调用写单任务 manifest（`gateway_manifest.yaml`，
  `repl_profile: lite`、`repl_auto_first_user: true`、`repl_exit_after_auto: true`），
  query 写入 `gateway_first_user.txt` 供 REPL 首轮自动执行。
- **heavy**：不写 manifest，query 直接经 `-t` 传给 LNR solver，执行目录为
  `<workspace>/run`，任务日志落在 `<workspace>/run/task_logs`。
- **超时**：lite 用 `agent.timeout`；heavy 用 `agent.heavy_timeout`（为 0 时沿用 `timeout`）。
- **快照**：task 快照新增 `mode` 字段（`lite`/`heavy`），RAW.log header 亦记录 `mode=`
  与实际执行的完整命令行。

## 错误处理

| 场景 | HTTP 状态码 | 前端表现 |
|------|-------------|----------|
| 已有任务正在运行 | 409 Conflict | 平台消息显示 "an agent task is already running" |
| 任务队列已满 | 503 Service Unavailable | 平台消息显示 "agent task queue is full" |
| mode 非法（非 lite/heavy） | 400 Bad Request | 平台消息显示 "Failed: <error>" |
| 其他错误 | 非 202 | 平台消息显示 "Failed: <error>" |
| 无 gateway session | 前端拦截 | 不发送，debug 日志记录 |

## 关键代码位置

| 步骤 | 文件 | 说明 |
|------|------|------|
| 模式切换 UI | `ChatRail.tsx` ~360 | `mode-toggle` 开关按钮 |
| 切换处理 | `ChatRail.tsx` ~183 | `handleTaskModeSelect` — 纯本地 setTaskMode |
| 发送逻辑 | `ChatRail.tsx` ~96 | `handleSend` — 读取 taskMode 调用 gatewayInvokeAgent |
| API 封装 | `gateway.ts` ~123 | `gatewayInvokeAgent(token, sessionId, query, mode)` |
| Wails 绑定 | `wailsjs/go/main/App.js` | `GatewayInvokeAgent(arg1, arg2, arg3)` |
| Go 请求构造 | `gateway.go` ~293 | `GatewayInvokeAgent` — 注入 `[mode=X]` 前缀 |
| Go HTTP 发送 | `gateway.go` ~88 | `gatewayDo("POST", "/sessions/{id}/invoke", ...)` |
