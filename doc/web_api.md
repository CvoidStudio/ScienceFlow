# log_gateway_server 前端对接 API 文档

本文档覆盖前端与 `log_gateway_server` 交互的全部接口：鉴权、会话管理、日志实时流（SSE）、快照拉取、ScienceFlow agent 主动调用与实时输出、以及工作区文件树同步。

## 目录

1. [架构概述](#1-架构概述)
2. [通用约定](#2-通用约定)
3. [鉴权](#3-鉴权)
4. [会话管理](#4-会话管理)
5. [日志源查询](#5-日志源查询)
6. [实时流式 SSE](#6-实时流式-sse)
7. [日志快照拉取](#7-日志快照拉取)
8. [ScienceFlow Agent 调用](#8-scienceflow-agent-调用)
9. [Agent 实时输出 RAW.log](#9-agent-实时输出-rawlog)
10. [工作区文件树同步](#10-工作区文件树同步)
11. [后端 API 反向代理](#11-后端-api-反向代理)
12. [健康检查与演示页](#12-健康检查与演示页)
13. [数据模型](#13-数据模型)
14. [错误处理与状态码](#14-错误处理与状态码)
15. [完整前端接入流程](#15-完整前端接入流程)
16. [TypeScript 封装示例](#16-typescript-封装示例)

---

## 1. 架构概述

```
前端 ──HTTP/SSE──> log_gateway_server ──> ScienceFlow Agent (subprocess)
                      │                      │
                      ├─ 鉴权 + 会话 + 源级 ACL   ├─ 工作目录: $WS_ROOT/<user>/<session>/run/
                      ├─ SSE 日志推送             └─ RAW.log: $WS_ROOT/task_logs/<user>/<session>/RAW.log
                      └─ /api/* 反代到后端
```

`log_gateway_server` 是前端与 ScienceFlow 之间的中间服务：

- **鉴权**：用户名+密码登录换取 HMAC 签名 token。
- **会话订阅**：每个前端连接创建一个 session，声明订阅哪些日志源；可动态增删，SSE 无需重连。
- **实时流式推送**：通过 SSE 把日志行（含 agent stdout 的 RAW.log）实时推给前端。
- **快照拉取**：一次性返回某文件完整已有内容。
- **Agent 调用**：`POST /sessions/{id}/invoke` 在用户 session 目录下启动 ScienceFlow agent 子进程，stdout 实时写入 RAW.log 并经 SSE 推送。

### 1.1 基址与默认配置

| 项 | 默认值 |
|----|--------|
| 服务地址 | `http://<host>:8080` |
| SSE 路径 | `/events` |
| token 有效期 | `24h`（`auth.token_ttl`） |
| session 空闲过期 | `1h`（`auth.session_ttl`） |
| agent 并发上限 | `4`（`agent.max_concurrent`） |
| agent 队列上限 | `16`（`agent.max_queue`） |
| agent 任务超时 | `agent.timeout`（0=不限）；heavy 任务用 `agent.heavy_timeout`（0=沿用 timeout） |

下文示例以 `BASE = http://127.0.0.1:8080` 为基址。

### 1.2 前置条件

- 服务端已开启鉴权（`auth.enabled: true`），已拿到账号（如 `admin` / `admin123`）。
- 若关闭鉴权（`auth.enabled: false`），可跳过登录，SSE 使用 `?source=a,b` 静态过滤。

---

## 2. 通用约定

### 2.1 鉴权 token 携带方式

除 `POST /login` 外，所有控制面接口须携带 token，二选一：

1. **HTTP 头（推荐）**：
   ```
   Authorization: Bearer <token>
   ```
2. **查询参数**（EventSource 无法设头时）：
   ```
   ?token=<token>
   ```

### 2.2 CORS

所有接口响应包含：

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
Access-Control-Allow-Allow-Headers: Authorization, Content-Type
```

OPTIONS 预检请求返回 `204 No Content`，跨域前端可直接调用。

### 2.3 内容类型

- 请求体：`Content-Type: application/json`
- 响应体：`application/json`（SSE 除外，SSE 为 `text/event-stream`）

---

## 3. 鉴权

### 3.1 登录 `POST /login`

**请求体**：

```json
{
  "user_name": "admin",
  "password": "admin123"
}
```

**成功响应 `200`**：

```json
{
  "token": "eyJ...",
  "expires_at": "2026-09-02T08:00:00Z",
  "user": "admin",
  "sources": ["prefixed-logs", "raw-logs", "plain-text", "agent-logs"]
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `token` | string | HMAC 签名令牌，后续请求须携带 |
| `expires_at` | string | token 过期时间（RFC3339，UTC） |
| `user` | string | 用户名 |
| `sources` | string[] | 该用户有权限读取的日志源名列表 |

**失败响应 `401`**，响应体固定为纯文本：

```
用户不存在或密码错误
```

> 若鉴权未启用（`auth.enabled: false`），调用此接口返回 `400`：`鉴权未启用`。

---

## 4. 会话管理

会话代表一个前端连接的订阅状态。同一用户可开多个会话（多端），互不干扰。

### 4.1 创建会话 `POST /sessions`

**请求头**：`Authorization: Bearer <token>`

**请求体**：

```json
{
  "sources": ["agent-logs", "prefixed-logs"]
}
```

**响应 `200`**：

```json
{
  "session_id": "17efc6705d49623b5304cf1486d4f945",
  "name": "20260907-112451",
  "user": "admin",
  "sources": ["agent-logs", "prefixed-logs"]
}
```

| 字段 | 说明 |
|------|------|
| `name` | 会话名，创建时以当前时间戳生成，格式 `%Y%m%d-%H%M%S`（如 `20260907-112451`） |

> `sources` 会被服务端按用户 ACL 过滤后返回。无权限的源被静默丢弃，实际有效订阅以响应为准。

### 4.2 查询会话 `GET /sessions/{id}`

**响应 `200`**：

```json
{
  "session_id": "17ef...",
  "name": "20260907-112451",
  "user": "admin",
  "sources": ["agent-logs", "prefixed-logs"],
  "last_active": "2026-09-07T05:57:29.053523827Z",
  "last_active_nanos": 1788760649053523827,
  "agent": {
    "status": "active",
    "task": { "id": "task-...", "status": "running", "mode": "lite", "...": "..." }
  }
}
```

| 字段 | 说明 |
|------|------|
| `name` | 会话名（创建时间戳 `%Y%m%d-%H%M%S`） |
| `last_active` | 最近活跃时间（RFC3339 纳秒，UTC；查询本身会刷新该时间） |
| `last_active_nanos` | 同上的 unix 纳秒（便于前端排序） |
| `agent` | 该 session 的 agent 状态：`{"status":"idle"}` 或 `{"status":"active","task":<快照>}` |

**`404`**：`session not found`

### 4.3 列出用户全部会话 `GET /sessions`

返回当前用户**存活**的所有会话（按最近活跃倒序），供前端做会话管理/切换列表：

**响应 `200`**：

```json
{
  "user": "admin",
  "sessions": [
    {
      "session_id": "17ef...",
      "name": "20260907-112451",
      "user": "admin",
      "sources": ["agent-logs"],
      "last_active": "2026-09-07T05:57:29.053523827Z",
      "last_active_nanos": 1788760649053523827,
      "agent": { "status": "active", "task": { "...": "..." } }
    }
  ]
}
```

- 每个元素结构同 `GET /sessions/{id}`（§4.2），`agent` 字段便于前端直接展示哪些会话有任务在跑。
- 仅返回**未过期**的会话（空闲超过 `session_ttl` 已被回收的不再出现）。
- 列表本身**不刷新**会话 TTL（只读操作）。

### 4.4 激活/切换会话 `POST /sessions/{id}/activate`

刷新会话空闲 TTL 并返回当前状态，用于前端切换回历史会话（恢复订阅源、判断 agent 状态）：

**响应 `200`**（结构同 §4.2；该调用**会刷新** `last_active`）：

```json
{
  "session_id": "17ef...",
  "user": "admin",
  "sources": ["agent-logs"],
  "last_active": "2026-09-07T05:57:29.053523827Z",
  "last_active_nanos": 1788760649053523827,
  "agent": { "status": "idle" }
}
```

**切换流程建议**：前端保存 session_id → 需要切换时 `POST /sessions/{id}/activate` 校验会话仍存活 → 用返回的 `sources` 恢复订阅 → 重新建立 `GET /events?session=<id>` SSE 连接。

**`404`**：`session not found`（已过期/已删除）；**`401`**：越权访问他人会话。

### 4.5 更新订阅源 `PUT /sessions/{id}/sources`

**请求体**（全量替换）：

```json
{
  "sources": ["agent-logs"]
}
```

**响应 `200`**：

```json
{
  "session_id": "17ef...",
  "sources": ["agent-logs"]
}
```

> 更新后，已建立的 SSE 连接**实时生效**，无需重连。

### 4.6 删除会话 `DELETE /sessions/{id}`

**响应 `204`**（无响应体）。

**`404`**：`session not found`

---

## 5. 日志源查询

### 5.1 获取可订阅源 `GET /sources`

**请求头**：`Authorization: Bearer <token>`

**响应 `200`**：

```json
{
  "sources": [
    {
      "name": "agent-logs",
      "files": ["/.../task_logs/admin/<session>/RAW.log"]
    },
    {
      "name": "prefixed-logs",
      "files": ["/.../logs/sample.log"]
    }
  ]
}
```

前端可用此接口渲染可订阅源列表。

---

## 6. 实时流式 SSE

### 6.1 连接（鉴权模式）

```http
GET /events?session=<session_id>
```

连接成功后服务端先发一行注释：

```
: connected
```

随后（鉴权模式下）推送**缓存日志回填**（`event: backfill`，见 §6.4），把当前订阅源
已有内容一次性同步给前端，再进入实时跟踪（`event: log`）。空闲时每 15 秒发送心跳注释
`: ping` 保活。

> 切换 session 后重新建立 SSE 连接即可自动拿到历史日志 + 继续跟踪，无需单独调用
> `GET /read_cached_content`。

### 6.2 无鉴权模式

```http
GET /events                     # 订阅所有源
GET /events?source=src1,src2    # 只订阅指定源（逗号分隔，匹配 input 或 path）
```

> 无鉴权模式的过滤是静态的，切换需重连。

### 6.3 动态更新订阅

SSE 连接建立后，调 `PUT /sessions/{id}/sources` 即可增删订阅，服务端实时调整推送范围，**无需断开重连**。

### 6.4 SSE 报文格式

```
: connected

event: backfill
id: 1
data: {"source":"agent-logs","path":"/.../RAW.log","size":37,"returned":37,"truncated":false,"content":"=== header ===\n...\n"}

event: backfill-done
id: 2
data: {"count":1}

event: log
id: 3
data: {"input":"agent-logs","file":"RAW.log","path":"/.../RAW.log","message":"2+2 equals 4.","mode":"line","timestamp":"2026-09-02T03:06:58.123456789Z","offset":229}

: ping
```

- `id`：服务端自增序号，可用于检测事件丢失（`lastId + 1 != newId`）。
- `event: backfill`（鉴权模式）：连接时对每个订阅源缓存内容的快照，字段 `source/path/size/returned/truncated/content`；多个文件各发一条。
- `event: backfill-done`：回填结束标记，`count` 为回填文件数，之后即进入实时跟踪。
- `event: log`：实时日志事件，`data` 为 JSON 编码的 Event 对象（见 [12.1](#121-sse-event)）。
- `:` 开头的行是注释（`connected` / `ping`），浏览器 `EventSource` 不会派发为事件，可忽略。

### 6.5 浏览器 EventSource 用法

```javascript
// EventSource 无法自定义 Header，session 放查询参数
const es = new EventSource(`${BASE}/events?session=${sessionId}`);

es.addEventListener('backfill', (e) => {
  const snap = JSON.parse(e.data);
  // snap.source, snap.path, snap.size, snap.returned, snap.truncated, snap.content
  // 作为初始内容渲染到日志面板
});

es.addEventListener('backfill-done', (e) => {
  const { count } = JSON.parse(e.data);
  // 历史回填完成，后续 event: log 为实时增量
});

es.addEventListener('log', (e) => {
  const msg = JSON.parse(e.data);
  // msg.input, msg.file, msg.path, msg.message, msg.timestamp, msg.offset
});

es.onerror = () => {
  // 连接中断；浏览器自动重连
  // 若 session 过期或服务重启，重连会收到 401 且不再重试
  // 此时应重新 createSession 并重开 SSE
};
```

### 6.6 背压与性能

- 每订阅连接有 256 条缓冲；日志洪峰时慢消费者**丢弃事件**（不阻塞采集）。
- `raw` 模式按 ≤32KB/块推送，块为 base64（约 4/3 膨胀）。

---

## 7. 日志快照拉取

一次性返回某文件的**全部已有内容**，每次请求从磁盘最新读取，与采集 offset 无关。用于页面首次加载渲染历史内容。

### 7.1 按路径拉取 `GET /read_cached_content?path=<path>`

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE/read_cached_content?path=logs/sample.log"
```

相对或绝对路径均可。

### 7.2 按源名拉取 `GET /read_cached_content?source=<name>`

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE/read_cached_content?source=agent-logs"
```

若源命中多个文件，返回文件列表：

```json
{
  "source": "agent-logs",
  "files": ["/.../RAW.log", "/.../other.log"]
}
```

前端再按 `path` 逐个拉取。

### 7.3 单文件响应

```json
{
  "path": "/.../logs/sample.log",
  "size": 242,
  "returned": 242,
  "truncated": false,
  "content": "20260828-10:00:00.123456 INFO ...\n..."
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `path` | string | 文件绝对路径 |
| `size` | int64 | 文件当前大小（字节） |
| `returned` | int64 | 实际返回的字节数 |
| `truncated` | bool | 文件超 16MB 时仅返回末尾 16MB，此时为 `true` |
| `content` | string | 文件内容（UTF-8 字符串） |

---

## 8. ScienceFlow Agent 调用

开启 `agent.enabled` 后，前端可通过以下接口在用户 session 目录下启动 ScienceFlow agent 子进程执行任务。

### 8.1 触发任务 `POST /sessions/{id}/invoke`

**请求头**：`Authorization: Bearer <token>`

**请求体**：

```json
{
  "query": "分析 dataset/ 下的数据并产出 best_solution.json",
  "mode": "heavy"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `query` | string | 必填。用户消息，可携带 `[mode=lite]` / `[mode=heavy]` 前缀（见下文模式解析） |
| `mode` | string | 可选。`lite` / `heavy`，缺省 `lite` |

#### 任务模式（lite / heavy）

gateway 按模式启动**不同类型的智能体任务**（对应 `scienceflow.cli` 不同入口）：

| 模式 | 启动命令 | 用途 |
|------|----------|------|
| `lite`（默认） | `python -m scienceflow.cli repl -m <manifest> --auto-first-user --exit-after-auto --plain` | 轻量交互式 REPL 求解（单任务 manifest，`repl_profile: lite`） |
| `heavy` | `python -m scienceflow.cli run --type lnr -t <query> -w <workspace> [-c <config>] [-d <input_data_dir>]` | 长周期 LNR pipeline（完整 ML 流水线） |

**模式解析优先级**（三者可并存，高优先级生效）：

1. JSON `mode` 字段（显式声明，优先级最高）
2. `query` 前缀 `[mode=lite]` / `[mode=heavy]`（desktop 层注入，见 `doc/msg_task_type.md`；解析后前缀被剥离，agent 收到的是干净的 query）
3. 缺省 `lite`

非 `lite`/`heavy` 的模式值返回 `400`。lite/heavy 各自的墙钟超时分别由 `agent.timeout` / `agent.heavy_timeout` 控制（`heavy_timeout` 为 0 时沿用 `timeout`）。

**成功响应 `202`**（task 已入队/启动）：

```json
{
  "id": "task-1788318418198667787",
  "user": "admin",
  "session": "f2d8dad20609a4471e07aab9aa5f79e4",
  "status": "queued",
  "mode": "heavy",
  "workspace": "/tmp/sciflow_test/admin/f2d8.../run",
  "log_dir": "/tmp/sciflow_test/admin/f2d8.../run/task_logs",
  "raw_log_path": "/tmp/sciflow_test/task_logs/admin/f2d8.../RAW.log"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 任务唯一 ID |
| `status` | string | `queued` / `running` / `done` / `failed` / `killed` |
| `mode` | string | `lite` / `heavy`（本任务实际执行模式） |
| `workspace` | string | agent 执行目录 |
| `log_dir` | string | scienceflow 自身日志目录 |
| `raw_log_path` | string | agent stdout 实时写入的 RAW.log 路径 |

**冲突响应 `409`**（同 session 有任务在跑）：

```json
{
  "error": "an agent task is already running for this session",
  "task": { ... }
}
```

**队列满响应 `503`**：

```json
{
  "error": "agent task queue is full; try again later",
  "queued": 16,
  "running": 4
}
```

### 8.2 查询状态与输出 `GET /sessions/{id}/agent`

**响应 `200`**（有任务时）：

```json
{
  "task": {
    "id": "task-1788318418198667787",
    "user": "admin",
    "session": "f2d8...",
    "status": "running",
    "workspace": "/tmp/.../run",
    "log_dir": "/tmp/.../run/task_logs",
    "raw_log_path": "/tmp/.../RAW.log",
    "started_at": "2026-09-02T03:06:57.123456789Z"
  },
  "output": "ScienceFlow REPL ...\n2 + 2 equals 4.\n...",
  "running": true,
  "queue_stats": {
    "queued": 0,
    "running": 1
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `task` | object | 任务快照（见 [12.2](#122-task-snapshot)） |
| `output` | string | agent 最近 stdout/stderr（≤256KB），从 ring buffer 读取 |
| `running` | bool | 当前任务是否在运行 |
| `queue_stats` | object | 全局队列统计：`{queued: N, running: N}` |

**无任务时 `200`**：

```json
{ "status": "idle" }
```

### 8.3 停止任务 `DELETE /sessions/{id}/agent`

杀掉当前 session 的 agent 子进程。若任务还在队列中，标记为 `killed` 并跳过执行。

**响应 `200`**：返回最终 task 快照。

**`404`**：`no agent task for this session`

### 8.4 续聊（多轮对话）

同一 `user/session` 的 workspace 重复 `invoke` 会自动加载已有 memory（scienceflow CLI 既有行为），实现多轮对话。lite 任务每次 invoke 生成新的 manifest 与 first-user query 文件；heavy 任务直接以 query 作为 `run --type lnr` 的任务描述。workspace 路径不变。

---

## 9. Agent 实时输出 RAW.log

agent 子进程的 stdout/stderr（含 REPL 交互、LLM 回答、工具调用与结果）在运行过程中实时追加写入：

```
$SCIFLOW_WORKSPACE_ROOT/task_logs/<user>/<session>/RAW.log
```

该文件被 gateway 的 tailer 自动监听（源名 `agent-logs`），新增的每一行通过 SSE `event: log` 推送至已订阅该源的会话。前端无需轮询——只要 session 订阅了 `agent-logs` 源，打开 SSE 连接即可实时看到 agent 的逐行输出。

### 9.1 RAW.log 文件格式

```
=== [2026-09-02T03:06:58.123456789Z] task=task-1788318418198667787 mode=lite query="What is 2+2?" ===
=== cmd: python3 -m scienceflow.cli repl -m .../gateway_manifest.yaml --auto-first-user --exit-after-auto --plain ===
ScienceFlow REPL (type exit, quit, or exit() to quit)
[repl-auto] running file first-user query
2 + 2 equals 4.

→ ls
{"path": ".", "recursive": true, "depth": 2}
...
```

- 每次 invoke 前写入带 task ID + mode + query 的分隔 header，紧跟一行实际执行的完整命令行
- 文件以 append 模式累积，同一 session 多次调用的输出都保留

### 9.2 SSE 消息示例（RAW.log 行）

```json
{
  "input": "agent-logs",
  "file": "RAW.log",
  "path": "/tmp/.../task_logs/admin/<session>/RAW.log",
  "message": "2 + 2 equals 4.",
  "mode": "line",
  "timestamp": "2026-09-02T03:06:58.123456789Z",
  "offset": 229
}
```

### 9.3 延迟

agent stdout → pipe → RAW.log 文件 → tailer 读取（poll_interval 100ms）→ SSE 推送。端到端延迟约 100~200ms。

---

## 10. 工作区文件树同步

session 的 workspace 目录（`$SCIFLOW_WORKSPACE_ROOT/<user>/<session>/`）的文件树通过两种方式同步给前端：

1. **SSE 实时推送**：建立 SSE 连接时立即收到完整文件树（`event: file`，kind=`tree`）；连接保持期间，gateway 按 `agent.file_sync_interval`（默认 3s）轻量轮询目录，检测到新增/删除/修改时增量推送（kind=`changes`）。
2. **REST 主动拉取**：`GET /sessions/{id}/files` 任意时刻拉取当前完整文件树。

监控是**按需的**：只有当 session 有活跃 SSE 连接时才运行目录轮询，连接断开后自动停止。

### 10.1 拉取文件树 `GET /sessions/{id}/files`

**请求头**：`Authorization: Bearer <token>`

**响应 `200`**：

```json
{
  "root": "/data/sciflow_ws/admin/<session>/",
  "tree": [
    {
      "name": "hello.py",
      "path": "run/hello.py",
      "type": "file",
      "size": 27,
      "mtime": 1788414992269841979
    },
    {
      "name": "dataset",
      "path": "run/dataset",
      "type": "symlink",
      "size": 0,
      "mtime": 1788414992269841979
    }
  ]
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `root` | string | workspace 根目录绝对路径 |
| `tree[]` | array | 文件树条目，按 `path` 排序 |
| `tree[].name` | string | 文件/目录名 |
| `tree[].path` | string | 相对 root 的斜杠分隔路径 |
| `tree[].type` | string | `file` / `dir` / `symlink` |
| `tree[].size` | int64 | 字节数（目录为 0） |
| `tree[].mtime` | int64 | 修改时间（unix 纳秒） |

**轻量约束**：深度 ≤10 层、总条目 ≤5000；`.git` 等 VCS 目录跳过；符号链接只报告不展开（大数据集链接保持低成本）。

### 10.2 SSE 文件事件

与日志事件共用同一 SSE 连接，事件类型为 `file`：

**初始全量树**（连接建立即发送）：

```
event: file
id: 21
data: {"kind":"tree","root":"/data/sciflow_ws/admin/<session>/","tree":[...],"timestamp":"..."}
```

**增量变化**（目录增删改时）：

```
event: file
id: 42
data: {"kind":"changes","added":[{"name":"hello.py","path":"run/hello.py","type":"file","size":27,"mtime":...}],"removed":[],"modified":[],"timestamp":"..."}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `kind` | string | `tree`（全量）或 `changes`（增量） |
| `root` | string | 仅 `tree` 事件携带 |
| `tree` | array | 仅 `tree` 事件：完整文件树 |
| `added` / `removed` / `modified` | array | 仅 `changes` 事件：变化的条目（Node 结构同上） |
| `overflow` | bool | 变化条目超过上限（2000）被截断时置 `true`，前端应重新拉取全量树 |
| `timestamp` | string | 事件时间（RFC3339 纳秒） |

### 10.3 前端用法

```javascript
const es = new EventSource(`${BASE}/events?session=${sessionId}`);

// 日志事件
es.addEventListener('log', (e) => { /* ... */ });

// 文件树事件
es.addEventListener('file', (e) => {
  const ev = JSON.parse(e.data);
  if (ev.kind === 'tree') {
    renderFullTree(ev.tree);           // 初始全量渲染
  } else {
    ev.added.forEach(n => addNode(n));    // 新增（含目录）
    ev.removed.forEach(n => removeNode(n)); // 删除
    ev.modified.forEach(n => updateNode(n)); // 修改（size/mtime 变化）
    if (ev.overflow) refetchTree();      // 截断时全量校准
  }
});

// 任意时刻主动校准
async function refetchTree() {
  const res = await fetch(`${BASE}/sessions/${sessionId}/files`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.json(); // { root, tree }
}
```

### 10.4 配置

| 配置项 | 默认 | 说明 |
|--------|------|------|
| `agent.file_sync_interval` | `3s` | 目录变化轮询间隔（仅在有活跃 SSE 订阅时运行） |

### 10.5 文件内容获取 `GET /api/workspace/file/content`

按需拉取 session workspace 内单个文件的内容，供前端预览渲染。**由 gateway 直接从磁盘读取**（不走后端代理），路径与文件树中的 `path` 字段一致（相对 workspace root）。

**请求**：

```http
GET /api/workspace/file/content?session_id=<sid>&path=run/hello.py
Authorization: Bearer <token>
```

| 参数 | 说明 |
|------|------|
| `session_id` | 必填，会话 ID（决定 workspace 根目录） |
| `path` | 必填，相对 workspace root 的文件路径（如 `run/hello.py`，支持嵌套子目录） |

**响应 `200`**：

```json
{
  "path": "run/hello.py",
  "size": 32,
  "returned": 32,
  "truncated": false,
  "mtime": 1788414992269841979,
  "content_type": "text/x-python",
  "encoding": "utf8",
  "content": "def add(a, b):\n    return a + b\n"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `path` | string | 请求的相对路径 |
| `size` | int64 | 文件总大小（字节） |
| `returned` | int64 | 实际返回字节数 |
| `truncated` | bool | 文件超 32MB 时仅返回末尾 32MB，置 `true` |
| `mtime` | int64 | 修改时间（unix 纳秒） |
| `content_type` | string | 按扩展名映射（`.py`→`text/x-python`、`.md`→`text/markdown`、`.png`→`image/png`…），未识别时用内容嗅探 |
| `encoding` | string | 文本为 `utf8`；二进制/图片为 `base64`（`content` 为 base64 串） |
| `content` | string | 文件内容（UTF-8 字符串或 base64） |

**content_type 映射覆盖**：`py/js/ts/go/rs/md/json/csv/html/yaml/sh/c/java/sql/r` 等代码/文本类型；`png/jpg/gif/webp/svg/pdf` 等媒体类型；`pkl/h5/pt/npy/zip/gz` 等二进制类型（自动走 base64）。

**安全约束**：

- 鉴权同其他 session 接口：token 对应用户必须拥有该 session，越权返回 `401`
- 路径穿越防护：`path` 含 `..` 或绝对路径逃逸 workspace root 时返回 `400`
- 目录返回 `400`；文件不存在返回 `404`

**错误**：

| 状态码 | 场景 |
|--------|------|
| `400` | 缺参数 / 路径穿越 / path 是目录 |
| `401` | 无 token / 越权访问他人 session |
| `404` | session 不存在 / 文件不存在 |
| `503` | agent 未启用或 workspace root 未配置 |

> 该路由注册在 `/api/` 反代之前，gateway 精确匹配后不再转发后端。若 agent 未启用，本接口返回 `503`（不再回退后端）。

> 文件/目录的上传下载接口（`file/upload`、`directory/upload`、`file/download`、`directory/download`）
> 见 `doc/files_upload_download.md`。

---

## 11. 后端 API 反向代理

### `ANY /api/*`

所有 `/api/` 前缀的请求被反向代理到 `backend.url`（默认 `http://127.0.0.1:8200`），使前端可以把 gateway 作为唯一入口。

- **Authorization 头透传**：gateway 的 token（或后端自己的 bearer token）原样转发。
- **后端不可用时**返回 `502 Bad Gateway`：`backend unreachable: <error>`

---

## 12. 健康检查与演示页

### 11.1 健康检查 `GET /healthz`

无需鉴权。

```json
{"status":"ok","subscribers":3}
```

### 11.2 演示页 `GET /`

返回内置 HTML 页面，包含登录→建会话→SSE 推流的 JS 逻辑，可用于快速验证。

---

## 13. 数据模型

### 12.1 SSE Event

SSE 的 `data` 字段是一段 JSON。两种变体：

**文本模式（line / prefix）**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `input` | string | 逻辑源名（`config.json` 里 `inputs[].name`，如 `agent-logs`） |
| `file` | string | 文件名（basename，如 `RAW.log`） |
| `path` | string | 文件绝对路径 |
| `message` | string | 文本内容（一行或一段） |
| `mode` | string | `line` / `prefix` / `raw` |
| `timestamp` | string | 服务端读取时间，RFC3339 纳秒精度（UTC） |
| `offset` | int64 | 文件读取位置（字节），断点参考 |

**raw 模式（二进制块）**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `data` | string | base64 编码的原始字节 |
| `encoding` | string | 固定 `"base64"` |

```json
{
  "input": "raw-logs",
  "file": "sample.raw",
  "path": "/.../sample.raw",
  "data": "UkFX...base64...",
  "encoding": "base64",
  "mode": "raw",
  "timestamp": "...",
  "offset": 4096
}
```

### 12.2 Task Snapshot

`invoke` 响应、`agent` 状态查询的 `task` 字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 任务唯一 ID（`task-<nanos>`） |
| `user` | string | 用户名 |
| `session` | string | 会话 ID |
| `status` | string | `queued` / `running` / `done` / `failed` / `killed` |
| `mode` | string | `lite` / `heavy`（任务类型） |
| `workspace` | string | agent 执行目录绝对路径 |
| `log_dir` | string | scienceflow 自身日志目录 |
| `raw_log_path` | string | RAW.log 绝对路径（agent stdout 实时写入） |
| `started_at` | string | 启动时间（RFC3339 纳秒，UTC），未启动时省略 |
| `ended_at` | string | 结束时间，未结束时省略 |
| `exit_code` | int | 子进程退出码，终态时返回 |
| `error` | string | 错误信息，失败时返回 |

---

## 14. 错误处理与状态码

| 状态码 | 场景 | 响应体 |
|--------|------|--------|
| `200` | 成功（GET / 查询） | 见各接口 |
| `202` | agent invoke 成功（已入队/启动） | task 快照 |
| `204` | 删除会话成功 / OPTIONS 预检 | 空 |
| `400` | 请求体非法 / 缺参数 / 鉴权未启用时调 login | `invalid request body` 等 |
| `401` | 用户名/密码错 / token 无效或过期 / session 无效 / 越权 | `用户不存在或密码错误` |
| `404` | session 不存在 / source 无匹配文件 / 无 agent 任务 | 对应错误信息 |
| `409` | 同 session 已有任务在跑 | task 快照 |
| `500` | 服务端错误 | 错误信息 |
| `502` | 后端 API 代理不可用 | `backend unreachable: ...` |
| `503` | agent 未配置 / 队列满 | 错误信息 + `queued` / `running` 统计 |

**鉴权失败统一约定**：所有鉴权类失败（登录失败、token 失效、会话无效、越权）返回 `401`，响应体固定为纯文本 `用户不存在或密码错误`。前端可据此判断「需要重新登录」。

### 13.1 token 过期

token 默认 24h 有效。控制面请求收到 `401` 时，通常是 token 过期或服务重启（未配置固定 `token_secret`）。策略：捕获 `401` → 重新 `POST /login` → 用新 token 重试（会话也需重建）。

### 13.2 session 过期

session 空闲超过 `session_ttl`（默认 1h）被服务端回收。SSE 连接正常时，服务端心跳在 `ping` 时刷新会话活性。断网或页面长时间挂起导致连接断开后，超过 TTL 重连会失败（`401`），此时应重新 `createSession` 并重开 SSE。

### 13.3 断线续传

服务端在 SSE 中携带单调递增的 `id` 字段，可检测事件丢失。当前**不提供事件回放**（无 Last-Event-ID 续传）。若发现断档，用 `read_cached_content` 重新拉取全量快照校准。

---

## 15. 完整前端接入流程

```
1. POST /login              → 拿到 token + 可见 sources
2. GET  /sources            → 渲染可订阅源列表
3. POST /sessions           → 创建会话（订阅 agent-logs 等源）
4. GET  /events?session=ID  → 建立 SSE，消费实时日志
5. POST /sessions/ID/invoke → 触发 agent 任务（返回 raw_log_path）
6. SSE 实时推送 RAW.log 逐行内容（agent stdout）
7. GET  /sessions/ID/agent  → 轮询任务状态与 ring buffer 输出
8. PUT  /sessions/ID/sources→ 动态增删订阅（SSE 无需重连）
9. DELETE /sessions/ID/agent→ 停止当前任务
10. DELETE /sessions/ID     → 关闭会话 + 关闭 EventSource
```

**「先历史后增量」模式**：

```
4a. GET /read_cached_content?source=agent-logs  → 拉历史 RAW.log 内容，先渲染
4b. GET /events?session=ID                      → 开 SSE 追加增量
    用 offset 参考对齐点避免重复
```

---

## 16. TypeScript 封装示例

```typescript
const BASE = 'http://127.0.0.1:8080';

// ---- 类型 ----

interface LoginResult {
  token: string;
  expires_at: string;
  user: string;
  sources: string[];
}

interface Session {
  session_id: string;
  user?: string;
  sources: string[];
}

interface SourceInfo {
  name: string;
  files: string[];
}

interface LogEvent {
  input: string;
  file: string;
  path: string;
  message?: string;
  data?: string;
  encoding?: string;
  mode?: string;
  timestamp: string;
  offset: number;
}

interface Snapshot {
  path: string;
  size: number;
  returned: number;
  truncated: boolean;
  content: string;
}

interface TaskSnapshot {
  id: string;
  user: string;
  session: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'killed';
  workspace: string;
  log_dir: string;
  raw_log_path?: string;
  started_at?: string;
  ended_at?: string;
  exit_code?: number;
  error?: string;
}

interface AgentStatus {
  task: TaskSnapshot;
  output: string;
  running: boolean;
  queue_stats: { queued: number; running: number };
}

// ---- 客户端 ----

export class GatewayClient {
  private token: string | null = null;

  async login(userName: string, password: string): Promise<LoginResult> {
    const res = await fetch(`${BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_name: userName, password }),
    });
    if (!res.ok) throw new Error(`login failed: ${res.status}`);
    const data = await res.json() as LoginResult;
    this.token = data.token;
    return data;
  }

  private authHeaders(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  async listSources(): Promise<SourceInfo[]> {
    const res = await fetch(`${BASE}/sources`, { headers: this.authHeaders() });
    if (!res.ok) throw new Error(`listSources: ${res.status}`);
    return (await res.json()).sources;
  }

  async createSession(sources: string[]): Promise<Session> {
    const res = await fetch(`${BASE}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({ sources }),
    });
    if (!res.ok) throw new Error(`createSession: ${res.status}`);
    return res.json();
  }

  async updateSessionSources(sessionId: string, sources: string[]): Promise<Session> {
    const res = await fetch(`${BASE}/sessions/${sessionId}/sources`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({ sources }),
    });
    if (!res.ok) throw new Error(`updateSessionSources: ${res.status}`);
    return res.json();
  }

  async deleteSession(sessionId: string): Promise<void> {
    await fetch(`${BASE}/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: this.authHeaders(),
    });
  }

  async readSnapshot(path: string): Promise<Snapshot> {
    const res = await fetch(
      `${BASE}/read_cached_content?path=${encodeURIComponent(path)}`,
      { headers: this.authHeaders() },
    );
    if (!res.ok) throw new Error(`readSnapshot: ${res.status}`);
    return res.json();
  }

  // ---- agent ----

  async invokeAgent(sessionId: string, query: string): Promise<TaskSnapshot> {
    const res = await fetch(`${BASE}/sessions/${sessionId}/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({ query }),
    });
    if (res.status === 409) throw new Error('task already running');
    if (res.status === 503) throw new Error('queue full');
    if (!res.ok) throw new Error(`invoke: ${res.status}`);
    return res.json();
  }

  async getAgentStatus(sessionId: string): Promise<AgentStatus | { status: 'idle' }> {
    const res = await fetch(`${BASE}/sessions/${sessionId}/agent`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) throw new Error(`agentStatus: ${res.status}`);
    return res.json();
  }

  async stopAgent(sessionId: string): Promise<TaskSnapshot> {
    const res = await fetch(`${BASE}/sessions/${sessionId}/agent`, {
      method: 'DELETE',
      headers: this.authHeaders(),
    });
    if (!res.ok) throw new Error(`stopAgent: ${res.status}`);
    return res.json();
  }

  // ---- SSE ----

  openStream(sessionId: string, onEvent: (e: LogEvent) => void, onError?: () => void): EventSource {
    const es = new EventSource(`${BASE}/events?session=${sessionId}`);
    es.addEventListener('log', (ev) => onEvent(JSON.parse((ev as MessageEvent).data)));
    if (onError) es.onerror = onError;
    return es;
  }
}
```

### 使用示例

```typescript
const client = new GatewayClient();

// 1. 登录
const login = await client.login('admin', 'admin123');

// 2. 建会话，订阅 agent-logs
const session = await client.createSession(['agent-logs']);

// 3. 开 SSE，实时消费 agent 输出
const es = client.openStream(session.session_id, (ev) => {
  console.log(`[${ev.file}] ${ev.message}`);
});

// 4. 触发 agent 任务
const task = await client.invokeAgent(session.session_id, '分析数据并产出报告');

// 5. 轮询状态（SSE 已在实时推送 RAW.log 行，轮询补充 ring buffer 输出与终态）
const poll = setInterval(async () => {
  const st = await client.getAgentStatus(session.session_id);
  if ('task' in st && ['done', 'failed', 'killed'].includes(st.task.status)) {
    clearInterval(poll);
    es.close();
    console.log('task finished:', st.task.status, st.task.exit_code);
  }
}, 5000);
```
