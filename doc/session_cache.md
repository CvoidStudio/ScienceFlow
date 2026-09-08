# Session 切换：缓存日志回填与跟踪接口

本文档记录「切换 session 后读取已缓存日志并开始跟踪、同步给前端」这一改动点涉及的
接口调用与 SSE 事件协议。核心变化：切换/重连 session 时，gateway 会在同一条 SSE 流内
先回填历史日志，再继续实时跟踪，前端**无需**再单独调用 `GET /read_cached_content`。

## 1. 改动点概述

| 之前 | 之后 |
|------|------|
| SSE 只推新增日志；历史内容需前端逐个文件调 `GET /read_cached_content` 拉取 | SSE 连接即回填历史（`event: backfill`），随后进入实时跟踪 |
| 无明确的「回填完成」边界 | 新增 `event: backfill-done` 标记，前端据此区分历史/增量 |

## 2. 相关接口总览

| 接口 / 事件 | 类型 | 角色 |
|-------------|------|------|
| `POST /sessions/{id}/activate` | REST | 切换入口：校验会话存活、续期 TTL、返回 name/sources/agent 状态 |
| `GET /events?session=<id>` | SSE | 日志同步主通道：回填 + 实时跟踪 + 文件树 |
| `event: backfill` | SSE 事件 | 单个源缓存内容的快照 |
| `event: backfill-done` | SSE 事件 | 回填结束标记 |
| `event: log` | SSE 事件 | 实时日志增量 |
| `event: file` | SSE 事件 | 工作区文件树（初始全量 + 增量） |
| `GET /sessions/{id}/agent` | REST | 切换后查询 agent 运行状态/输出 |
| `GET /read_cached_content` | REST | 仍可用的一次性快照接口（回填机制出现后前端一般不再需要） |

## 3. 切换完整调用序列

```
1. POST /sessions/{id}/activate
   Authorization: Bearer <token>
   → 200 { session_id, name, user, sources, last_active, last_active_nanos, agent }

2. GET /events?session=<id>        （EventSource 用 ?token=<token> 传鉴权）
   → : connected
   → event: backfill   （每个订阅源一条，agent-logs 精确到本 session）
   → event: backfill-done { count }
   → event: log        （实时增量，持续）
   → event: file       （工作区文件树，持续）

3. （可选）GET /sessions/{id}/agent    → 任务运行状态 + 最近输出
4. （可选）POST /sessions/{id}/invoke  → 切换后开启新任务
```

## 4. SSE 事件协议

### 4.1 连接与回填

```http
GET /events?session=<session_id>
Authorization: Bearer <token>        # EventSource 无法设头时改为 ?token=<token>
```

服务端依次发送：

```
: connected

event: backfill
id: 1
data: {"source":"agent-logs","path":"/.../task_logs/<user>/<session>/RAW.log",
       "size":1024,"returned":1024,"truncated":false,"content":"=== header ===\n...\n"}

event: backfill
id: 2
data: {"source":"app","path":"/.../logs/app.log",
       "size":33,"returned":33,"truncated":false,"content":"app-line-1\n..."}

event: backfill-done
id: 3
data: {"count":2}

event: log
id: 4
data: {"input":"agent-logs","file":"RAW.log","path":"/.../RAW.log",
       "message":"2+2 equals 4.","mode":"line","timestamp":"...","offset":229}
```

### 4.2 `event: backfill` 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `source` | string | 源名（如 `agent-logs`） |
| `path` | string | 文件绝对路径 |
| `size` | int64 | 文件总大小（字节） |
| `returned` | int64 | 实际回填字节数 |
| `truncated` | bool | 超过 16MB（`maxSnapshotBytes`）时只回填末尾，置 `true` |
| `content` | string | 缓存日志内容（UTF-8） |

### 4.3 `event: backfill-done` 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `count` | int | 本次回填的文件数 |

### 4.4 事件顺序保证

- `backfill` 若干条（0..N）→ `backfill-done`（必发，`count` 可为 0）→ `log` 增量。
- 回填在进入事件循环**之前同步发送**，因此 `backfill-done` 之后收到的 `log` 一定是
  连接建立后的新内容（与历史内容可能存在极小窗口的重复，前端可按 `offset` 去重）。

## 5. 源 → 文件解析规则

回填按 session 订阅源逐个解析文件：

| 源类型 | 解析方式 |
|--------|----------|
| `agent-logs` | 精确到本会话：`<workspace_root>/task_logs/<user>/<session>/RAW.log`（按 session 计算，避免跨用户泄露） |
| 静态源（如 `prefixed-logs`） | `lookup(source)` 的 glob 匹配文件（全局共享、ACL 已过滤） |

> 相关实现：`sessionRawLogPath` / `backfillFiles` / `writeLogBackfill`
> （`internal/server/server.go`），`agent.RawLogSource` 常量（`internal/agent/runner.go`）。

## 6. 前端对接示例（TypeScript）

```ts
const es = new EventSource(`${BASE}/events?session=${sessionId}&token=${token}`);

es.addEventListener('backfill', (e) => {
  const s = JSON.parse(e.data) as {
    source: string; path: string; size: number; returned: number;
    truncated: boolean; content: string;
  };
  // 按 path 分组，作为该文件的历史日志初始渲染
  appendHistory(s.path, s.content, s.truncated);
});

es.addEventListener('backfill-done', (e) => {
  const { count } = JSON.parse(e.data);
  // 历史加载完成，之后 event: log 为实时增量，可移除 loading 态
  markHistoryLoaded(count);
});

es.addEventListener('log', (e) => {
  const msg = JSON.parse(e.data);
  // msg.input / msg.path / msg.message / msg.timestamp / msg.offset
  appendLive(msg.path, msg);
});
```

## 7. 与一次性快照接口的关系

`GET /read_cached_content?source=<s>&path=<p>` 仍保留，语义不变（读单个文件末尾 ≤16MB）。
SSE 回填是它的流式替代：切换 session 时推荐用回填，避免多次往返。

## 8. 错误与边界

- session 已过期/不存在：`GET /events` 返回 `401`（鉴权态），前端应重建会话。
- 订阅源无匹配文件：不发对应 `backfill`，`backfill-done.count` 相应减少。
- 文件不可读：跳过该文件（不报错中断流）。
- agent 未启用：无 `agent-logs` 回填；`/activate` 响应省略 `agent` 字段。
