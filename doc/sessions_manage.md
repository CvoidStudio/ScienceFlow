# Session 管理 / 查询 / 切换接口设计

本文档描述 log_gateway_server 中间服务对用户会话（session）的管理接口，
重点是**会话列表查询**（`GET /sessions`）与**会话切换**（`POST /sessions/{id}/activate`）
两个新增端点，以及它们与既有单会话 CRUD 接口的关系。

## 1. 会话模型

- 一个 session = 一个前端连接的订阅状态（用户 + 订阅源集合）。
- 同一用户可同时持有多个 session（多端/多标签页），互不干扰。
- session 为**内存存储**：进程重启即丢失；空闲超过 `auth.session_ttl`
  （默认 1h）会被后台清理协程回收，回收后不可恢复。
- 除创建外，所有 session 接口都校验**归属**：token 对应用户必须等于 session
  的 owner，否则 `401`。

## 2. 接口总览

| 接口 | 方法 | 用途 | 是否刷新 TTL |
|------|------|------|-------------|
| `/sessions` | POST | 创建会话 | — |
| `/sessions` | GET | 列出当前用户全部存活会话（新增） | 否 |
| `/sessions/{id}` | GET | 查询单个会话 | 是 |
| `/sessions/{id}/activate` | POST | 激活/切换会话（新增） | 是 |
| `/sessions/{id}/sources` | PUT | 更新订阅源（全量替换，SSE 实时生效） | 是 |
| `/sessions/{id}` | DELETE | 删除会话 | — |

## 3. 通用约定

### 3.1 鉴权

请求头：`Authorization: Bearer <token>`（`POST /login` 获取）。
鉴权关闭（`auth.enabled=false`）时所有用户视为同一匿名用户。

### 3.2 统一会话视图（sessionJSON）

`GET /sessions/{id}`、`GET /sessions`、`POST /sessions/{id}/activate` 返回同一
结构：

```json
{
  "session_id": "17efc6705d49623b5304cf1486d4f945",
  "name": "20260907-112451",
  "user": "admin",
  "sources": ["agent-logs", "prefixed-logs"],
  "last_active": "2026-09-07T05:57:29.053523827Z",
  "last_active_nanos": 1788760649053523827,
  "agent": {
    "status": "active",
    "task": {
      "id": "task-...",
      "status": "running",
      "mode": "lite",
      "workspace": "...",
      "log_dir": "...",
      "raw_log_path": "..."
    }
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `session_id` | string | 会话 ID |
| `name` | string | 会话名，创建时以时间戳生成（`%Y%m%d-%H%M%S`，如 `20260907-112451`） |
| `user` | string | 会话所有者 |
| `sources` | string[] | 订阅源（已按 ACL 过滤、排序） |
| `last_active` | string | 最近活跃时间（RFC3339 纳秒，UTC） |
| `last_active_nanos` | int64 | 同上的 unix 纳秒（便于前端直接排序） |
| `agent` | object | 该 session 的 agent 状态，见下 |

`agent` 字段取值：

```json
{ "status": "idle" }
```

或（该 session 有任务在跑/排队时，`task` 为完整 task 快照，含 `mode`）：

```json
{ "status": "active", "task": { ... } }
```

> agent 未启用（`agent.enabled=false`）时省略 `agent` 字段。

## 4. 会话列表查询 `GET /sessions`

### 4.1 请求

```
GET /sessions
Authorization: Bearer <token>
```

无参数。**只读操作，不刷新任何会话的 TTL**。

### 4.2 响应 `200`

```json
{
  "user": "admin",
  "sessions": [
    { "session_id": "...", "user": "admin", "sources": [...],
      "last_active": "...", "last_active_nanos": ..., "agent": { "status": "active", "task": {...} } },
    { "session_id": "...", "user": "admin", "sources": [...],
      "last_active": "...", "last_active_nanos": ..., "agent": { "status": "idle" } }
  ]
}
```

- `sessions` 按 `last_active` **倒序**（最近活跃在前）。
- 每个元素结构同统一会话视图（§3.2）。
- 仅包含**存活**（未被 TTL 回收）的会话；`user` 固定为当前 token 对应用户。

### 4.3 前端示例（会话管理列表）

```js
const res = await fetch(`${BASE}/sessions`, {
  headers: { Authorization: `Bearer ${token}` },
});
const { sessions } = await res.json();
// 渲染会话列表：name + last_active + agent 状态徽标
for (const s of sessions) {
  console.log(s.session_id, s.sources, s.agent.status, s.last_active);
}
```

## 5. 会话激活 / 切换 `POST /sessions/{id}/activate`

### 5.1 请求

```
POST /sessions/{id}/activate
Authorization: Bearer <token>
```

无请求体。调用后该会话的 `last_active` 刷新为当前时间（等效续期 `session_ttl`）。

### 5.2 响应 `200`

结构与统一会话视图（§3.2）一致：

```json
{
  "session_id": "17ef...",
  "name": "20260907-112451",
  "user": "admin",
  "sources": ["agent-logs"],
  "last_active": "2026-09-07T06:00:00.000000001Z",
  "last_active_nanos": ...,
  "agent": { "status": "idle" }
}
```

### 5.3 切换流程（推荐）

前端在本地持久化 session_id，需要切换回历史会话时：

```
1. POST /sessions/{id}/activate    → 校验会话存活，拿到 name/sources 与 agent 状态
2. 恢复订阅：以返回的 sources 渲染订阅面板 / 日志源选择
3. 重建 SSE：GET /events?session=<id>&token=<token>（EventSource 无法设头时用 token 查询参数）
   连接后服务端自动：
     a. 推送 event: backfill（各订阅源的缓存日志内容）→ event: backfill-done
     b. 进入实时跟踪（event: log 增量）；同时推送 event: file 工作区文件树
4. 若 agent.status == "active"：GET /sessions/{id}/agent 拉取输出；否则调用
   POST /sessions/{id}/invoke 开启新任务
5. 工作区：GET /sessions/{id}/files 拉文件树，文件内容走 /api/workspace/file/content
```

> 步骤 3 的缓存日志回填（backfill）意味着切换后**无需**再单独调用
> `GET /read_cached_content`；历史日志与实时跟踪在同一 SSE 流内完成。

### 5.4 前端示例

```js
async function switchSession(sessionId) {
  const res = await fetch(`${BASE}/sessions/${sessionId}/activate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) {
    // 会话已过期/被回收，需重建
    return createNewSession();
  }
  if (res.status === 401) {
    // token 失效，重新登录
    return reLogin();
  }
  const s = await res.json();
  closeCurrentSSE();
  openSSE(sessionId, s.sources);
  if (s.agent?.status === "active") {
    refreshAgentStatus(sessionId);
  }
  return s;
}
```

## 6. 单会话 CRUD（既有接口，仅列出差异）

### 6.1 创建 `POST /sessions`

```json
{ "sources": ["agent-logs"] }
```

响应：`{ "session_id", "name", "user", "sources" }`（`name` 为创建时间戳
`%Y%m%d-%H%M%S`；`sources` 为 ACL 过滤后的实际订阅）。
无权限的源被静默丢弃。

### 6.2 查询 `GET /sessions/{id}`

返回统一会话视图（§3.2）；该查询会刷新 TTL。

### 6.3 更新订阅源 `PUT /sessions/{id}/sources`

```json
{ "sources": ["agent-logs"] }
```

全量替换；已建立的 SSE 连接**实时生效**，无需重连。

### 6.4 删除 `DELETE /sessions/{id}`

响应 `204`。删除后该 session 的 SSE 订阅与 agent 任务状态查询均失效。

## 7. 错误码

| 状态码 | 场景 |
|--------|------|
| `400` | 请求体非法 / 缺参数 |
| `401` | 无 token / token 失效 / **越权访问他人 session** |
| `404` | session 不存在（含已被 TTL 回收） |
| `204` | 删除成功 |

## 8. 限制与注意事项

1. **无持久化**：session 在内存中，服务重启全部丢失；前端必须能容忍
   `activate`/`GET` 返回 `404` 并重建会话。
2. **TTL 回收**：空闲超过 `session_ttl`（默认 1h）即回收。列表查询不续期；
   只有 `GET /sessions/{id}`、`activate`、`PUT sources` 和活跃的 SSE 心跳
   会刷新 `last_active`。
3. **列表不跨用户**：每个用户只能看到自己的会话；admin 也没有全局列表。
4. **切换≠迁移**：activate 只恢复订阅状态与查询 agent/文件状态；
   workspace、文件、任务都绑定在 session_id 上，切换即回到该会话的完整上下文。
