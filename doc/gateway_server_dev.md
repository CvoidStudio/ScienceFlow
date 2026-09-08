# log_gateway_server 前端对接开发指南

本文档面向需要把 `log_gateway_server` 作为日志数据源接入的前端开发者，覆盖鉴权、会话、实时流（SSE）、快照拉取等全部对前端开放的接口，并给出可直接使用的代码示例。

## 目录

1. [架构概述](#1-架构概述)
2. [快速开始](#2-快速开始)
3. [鉴权与会话](#3-鉴权与会话)
4. [实时流式（SSE）](#4-实时流式sse)
5. [快照拉取（read_cached_content）](#5-快照拉取read_cached_content)
6. [消息数据模型](#6-消息数据模型)
7. [完整代码示例](#7-完整代码示例)
8. [错误处理与状态码](#8-错误处理与状态码)
9. [连接生命周期与最佳实践](#9-连接生命周期与最佳实践)
10. [常见问题](#10-常见问题)

---

## 1. 架构概述

```
日志文件 ──(tail)──> log_gateway_server ──(SSE 推送 / REST 快照)──> 前端
                        │
                        └─ 多用户鉴权 + 会话订阅 + 源级 ACL
```

`log_gateway_server` 是一个日志实时同步中间服务：

- **发现与读取**：监控多个日志文件（`config.json` 中的 `inputs`，每个输入有一个逻辑名 `name`，如 `prefixed-logs`）。
- **鉴权**：用户名 + 密码登录换取 token（HMAC 签名），token 用于后续所有控制面接口。
- **会话订阅**：每个前端连接创建一个 session，session 声明自己订阅哪些日志源；可通过接口动态增删，无需断开。
- **流式推送**：通过 **SSE（Server-Sent Events）** 把日志实时推给前端。
- **快照拉取**：`read_cached_content` 一次性返回某文件的完整已存内容。

### 1.1 基址与默认配置

| 项 | 默认值 |
|----|--------|
| 服务地址 | `http://<host>:8080`（示例用 `http://127.0.0.1:8080`） |
| SSE 路径 | `/events` |
| token 有效期 | `24h`（`auth.token_ttl`） |
| session 空闲过期 | `1h`（`auth.session_ttl`） |

下文示例一律以 `http://127.0.0.1:8080` 为基址，记为 `BASE`。

### 1.2 前置条件

- 服务端已开启鉴权（`auth.enabled: true`，见部署文档），并拿到一个可用的账号（如示例 `admin` / `admin123`）。
- 若服务端关闭鉴权（`auth.enabled: false`），可跳过登录，直接使用无会话模式的 SSE（见 [4.2 无鉴权模式](#42-无鉴权模式)）。

---

## 2. 快速开始

以下 curl 命令演示一个完整的「登录 → 建会话 → 消费流」流程：

```bash
BASE="http://127.0.0.1:8080"

# 1) 登录，拿到 token 与该用户可见的 sources
TOKEN=$(curl -s -X POST "$BASE/login" \
  -H 'Content-Type: application/json' \
  -d '{"user_name":"admin","password":"admin123"}' | jq -r .token)

# 2) 查看该用户可见的所有日志源
curl -s "$BASE/sources" -H "Authorization: Bearer $TOKEN" | jq

# 3) 创建会话，订阅指定源
SESSION=$(curl -s -X POST "$BASE/sessions" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"sources":["prefixed-logs","plain-text"]}' | jq -r .session_id)

# 4) 建立 SSE 流
curl -N "$BASE/events?session=$SESSION"
```

---

## 3. 鉴权与会话

### 3.1 登录 `POST /login`

请求：

```json
{ "user_name": "admin", "password": "admin123" }
```

成功响应（`200`）：

```json
{
  "token": "eyJ...",
  "expires_at": "2026-09-02T08:00:00Z",
  "user": "admin",
  "sources": ["prefixed-logs", "raw-logs", "plain-text"]
}
```

字段说明：

| 字段 | 说明 |
|------|------|
| `token` | 身份令牌，后续控制面请求必须携带 |
| `expires_at` | token 过期时间（RFC3339，UTC） |
| `user` | 用户名 |
| `sources` | 该用户有权限读取的日志源名列表（用于前端渲染可订阅项） |

失败响应（`401`），响应体固定为：

```
用户不存在或密码错误
```

### 3.2 携带 token 的方式

控制面接口（登录之外的 `/sessions*`、`/sources`、`/read_cached_content`）二选一携带 token：

1. **HTTP 头（推荐）**：
   ```
   Authorization: Bearer <token>
   ```
2. **查询参数**（EventSource 或无法设头的场景）：
   ```
   ?token=<token>
   ```

### 3.3 会话管理

会话代表「一个前端连接订阅哪些源」，同一用户可开多个会话（多端）。

#### 创建会话 `POST /sessions`

请求（须带 token）：

```json
{ "sources": ["prefixed-logs", "plain-text"] }
```

响应（`200`）：

```json
{
  "session_id": "17efc6705d49623b5304cf1486d4f945",
  "user": "admin",
  "sources": ["plain-text", "prefixed-logs"]
}
```

> 注意：`sources` 会被服务端按用户 ACL 过滤后返回。用户无权限的源会被静默丢弃。因此实际有效订阅应以响应中的 `sources` 为准。

#### 查询会话 `GET /sessions/{id}`

响应（`200`）：

```json
{
  "session_id": "17ef...",
  "user": "admin",
  "sources": ["plain-text", "prefixed-logs"]
}
```

#### 更新会话订阅 `PUT /sessions/{id}/sources`

请求体与创建一致，为**全量替换**：

```json
{ "sources": ["prefixed-logs"] }
```

响应（`200`）：

```json
{
  "session_id": "17ef...",
  "sources": ["prefixed-logs"]
}
```

更新后，已建立的 SSE 连接会**实时生效**（无需重连）。见 [4.3 动态更新订阅](#43-动态更新订阅)。

#### 删除会话 `DELETE /sessions/{id}`

成功返回 `204 No Content`。删除后该 session 对应的 SSE 连接应被前端主动关闭。

### 3.4 源列表 `GET /sources`

返回当前用户可见的日志源与其当前匹配到的文件路径：

```json
{
  "sources": [
    { "name": "prefixed-logs", "files": ["D:/work/.../logs/sample.log"] },
    { "name": "plain-text",     "files": ["D:/work/.../logs/app.txt"] },
    { "name": "raw-logs",       "files": ["D:/work/.../logs/sample.raw", "D:/work/.../logs/count.raw"] }
  ]
}
```

建议前端用它渲染「可订阅源」下拉列表。

---

## 4. 实时流式（SSE）

### 4.1 连接方式（鉴权模式下）

```text
GET /events?session=<session_id>
```

连接建立成功后，服务端先发送一行注释 `: connected`。之后每个日志事件以 `event: log` 推送；无事件时每 15 秒发送一次心跳注释 `: ping` 保活。

### 4.2 无鉴权模式

若服务端 `auth.enabled: false`，则无需登录与 session，直接用静态过滤：

```text
GET /events                    # 订阅所有源
GET /events?source=a,b         # 只订阅 source 名称为 a、b 的源（逗号分隔）
```

> 该过滤是静态的；要换订阅需重连。

### 4.3 动态更新订阅

SSE 连接建立后，前端仍可随时调用 `PUT /sessions/{id}/sources` 增删订阅，服务端会实时调整推送范围，**无需断开重连**。这是多端场景的关键能力。

### 4.4 SSE 原始报文示例

```
: connected

event: log
id: 1
data: {"input":"plain-text","file":"app.txt","path":"D:/.../app.txt","message":"hello","mode":"line","timestamp":"2026-09-01T01:00:00.123456789Z","offset":52}

: ping
```

SSE 规范要点：

- 每个 `data:` 行可能被折行（本服务单行 JSON，一般不会折行）。
- `id` 为服务端自增序号，可作为事件去重/断点参考（见 [9.3 断线续传](#93-断线续传)）。
- 以 `:` 开头的行是注释（`connected` / `ping`），浏览器 `EventSource` 不会把它们派发为事件，可忽略。

### 4.5 浏览器 EventSource 用法

```javascript
// EventSource 无法自定义 Header，因此 session 放查询参数里
const es = new EventSource(`${BASE}/events?session=${sessionId}`);

es.addEventListener('log', (e) => {
  const msg = JSON.parse(e.data);
  render(msg);
});

es.onerror = () => {
  // 连接中断/过期时触发；浏览器会自动重连
};
```

> ⚠️ EventSource 原生自动重连。但若 session 已过期或 service 重启，重连会收到 `401` 且不再重试。请在 `onerror` 里做 session 重建逻辑（见 [9.2](#92-session-过期处理)）。

---

## 5. 快照拉取（read_cached_content）

用于「页面首次加载时一次性拉取文件已有内容」，配合 SSE 实现「先历史、后增量」。

### 5.1 请求

按路径：

```text
GET /read_cached_content?path=logs/sample.log          # 相对或绝对路径均可
GET /read_cached_content?path=D:/work/.../logs/a.txt
```

按源名：

```text
GET /read_cached_content?source=prefixed-logs
```

鉴权模式下须带 `Authorization: Bearer <token>`（或 `?token=`），且只能读取用户有权限的源/路径。

### 5.2 响应

单文件快照（`200`）：

```json
{
  "path": "D:/work/.../logs/sample.log",
  "size": 242,
  "returned": 242,
  "truncated": false,
  "content": "20260828-10:00:00.123456 INFO ...\n..."
}
```

| 字段 | 说明 |
|------|------|
| `path` | 文件绝对路径 |
| `size` | 文件当前大小（字节） |
| `returned` | 实际返回的字节数 |
| `truncated` | 文件超过 16MB 时仅返回末尾 16MB，此时为 `true` |
| `content` | 文件内容（UTF-8 字符串） |

`?source=` 命中多个文件时返回文件列表（`200`）：

```json
{ "source": "raw-logs", "files": ["D:/.../a.raw", "D:/.../b.raw"] }
```

客户端可再逐个按 `path` 拉取。

---

## 6. 消息数据模型

SSE 的 `data` 字段是一段 JSON。三种读取模式（见 `config.json` 的 `inputs[].mode`）带来的字段差异：

### 6.1 `line` / `prefix` 模式（文本）

```json
{
  "input": "prefixed-logs",
  "file": "sample.log",
  "path": "D:/work/.../logs/sample.log",
  "message": "20260828-11:00:00.000001 INFO something",
  "mode": "prefix",
  "timestamp": "2026-09-01T01:00:00.123456789Z",
  "offset": 242
}
```

### 6.2 `raw` 模式（二进制/任意字节）

`raw` 模式不做行解析，直接按块推送，内容用 **base64** 编码放在 `data` 字段，并以 `encoding` 标识：

```json
{
  "input": "raw-logs",
  "file": "sample.raw",
  "path": "D:/work/.../logs/sample.raw",
  "data": "UkFXLVlPVVIgYnl0ZXMNCg==",
  "encoding": "base64",
  "mode": "raw",
  "timestamp": "2026-09-01T01:00:00.123456789Z",
  "offset": 111
}
```

### 6.3 通用字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `input` | string | 逻辑源名（`config.json` 里 `inputs[].name`） |
| `file` | string | 文件名（basename） |
| `path` | string | 文件绝对路径 |
| `message` | string | 文本内容（`line`/`prefix` 模式） |
| `data` | string | base64 内容（`raw` 模式） |
| `encoding` | string | 取值 `"base64"`，仅在 `raw` 模式出现 |
| `mode` | string | `line` / `prefix` / `raw` |
| `timestamp` | string | 服务端读取时间，RFC3339 纳秒精度（UTC） |
| `offset` | int64 | 文件读取位置（字节），可用于断点参考 |

### 6.4 前端解析建议

```javascript
function decodeMessage(msg) {
  if (msg.encoding === 'base64') {
    // 还原为原始字节；自行按需转文本/二进制
    const bytes = Uint8Array.from(atob(msg.data), c => c.charCodeAt(0));
    return { kind: 'raw', bytes, meta: msg };
  }
  return { kind: 'text', text: msg.message, meta: msg };
}
```

---

## 7. 完整代码示例

### 7.1 TypeScript 封装（推荐生产使用）

```typescript
// gateway.ts
const BASE = 'http://127.0.0.1:8080';

export interface LoginResult {
  token: string;
  expires_at: string;
  user: string;
  sources: string[];
}

export interface Session {
  session_id: string;
  user?: string;
  sources: string[];
}

export interface SourceInfo {
  name: string;
  files: string[];
}

export interface LogEvent {
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

export interface Snapshot {
  path: string;
  size: number;
  returned: number;
  truncated: boolean;
  content: string;
}

export class GatewayClient {
  private token: string | null = null;

  async login(userName: string, password: string): Promise<LoginResult> {
    const res = await fetch(`${BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_name: userName, password }),
    });
    if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
    const data = await res.json() as LoginResult;
    this.token = data.token;
    return data;
  }

  private authHeaders(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  async listSources(): Promise<SourceInfo[]> {
    const res = await fetch(`${BASE}/sources`, { headers: this.authHeaders() });
    if (!res.ok) throw new Error(`listSources failed: ${res.status}`);
    return (await res.json()).sources;
  }

  async createSession(sources: string[]): Promise<Session> {
    const res = await fetch(`${BASE}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({ sources }),
    });
    if (!res.ok) throw new Error(`createSession failed: ${res.status}`);
    return res.json();
  }

  async updateSessionSources(sessionId: string, sources: string[]): Promise<Session> {
    const res = await fetch(`${BASE}/sessions/${sessionId}/sources`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({ sources }),
    });
    if (!res.ok) throw new Error(`updateSessionSources failed: ${res.status}`);
    return res.json();
  }

  async deleteSession(sessionId: string): Promise<void> {
    await fetch(`${BASE}/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: this.authHeaders(),
    });
  }

  async readCachedContentBySource(source: string): Promise<Snapshot> {
    const res = await fetch(`${BASE}/read_cached_content?source=${encodeURIComponent(source)}`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) throw new Error(`readCachedContent failed: ${res.status}`);
    return res.json();
  }

  openStream(sessionId: string, onEvent: (e: LogEvent) => void, onError?: () => void): EventSource {
    const es = new EventSource(`${BASE}/events?session=${encodeURIComponent(sessionId)}`);
    es.addEventListener('log', (ev) => onEvent(JSON.parse((ev as MessageEvent).data)));
    if (onError) es.onerror = onError;
    return es;
  }
}
```

### 7.2 React Hook 示例

```tsx
import { useEffect, useRef, useState } from 'react';
import { GatewayClient, LogEvent } from './gateway';

export function useLogStream(client: GatewayClient, sessionId: string | null) {
  const [lines, setLines] = useState<LogEvent[]>([]);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    esRef.current?.close();
    if (!sessionId) return;

    const es = client.openStream(sessionId, (ev) => {
      setLines((prev) => [...prev.slice(-999), ev]); // 保留最近 1000 条
    });

    esRef.current = es;
    return () => es.close();
  }, [sessionId]);

  return { lines, clear: () => setLines([]) };
}

// 组件里：
//   const client = new GatewayClient();
//   await client.login(...);
//   const session = await client.createSession(['prefixed-logs']);
//   const { lines } = useLogStream(client, session.session_id);
```

### 7.3 原生 JS 最简示例

```javascript
async function main() {
  const login = await fetch(BASE + '/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_name: 'admin', password: 'admin123' }),
  }).then(r => r.json());

  const session = await fetch(BASE + '/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + login.token },
    body: JSON.stringify({ sources: login.sources }),
  }).then(r => r.json());

  const es = new EventSource(BASE + '/events?session=' + session.session_id);
  es.addEventListener('log', (e) => console.log(JSON.parse(e.data)));
}
```

---

## 8. 错误处理与状态码

| 状态码 | 场景 | 响应体 |
|--------|------|--------|
| `200` | 成功 | 见各接口 |
| `204` | 删除会话成功 | 空 |
| `400` | 请求体非法 / 缺参数 / 鉴权未启用 | `invalid request body` 等 |
| `401` | 用户名或密码错误 / token 无效或过期 / session 无效 / 越权访问源 | **`用户不存在或密码错误`** |
| `404` | session 不存在 / source 无匹配文件 | `session not found` / `no files match source "..."` |
| `500` | 服务端错误 | 错误信息 |

统一鉴权失败约定：所有鉴权类失败（登录失败、token 失效、会话无效、越权）都返回 **`401`，响应体固定为 `用户不存在或密码错误`**。前端可据此判断「需要重新登录」。

---

## 9. 连接生命周期与最佳实践

### 9.1 推荐的接入流程

1. `POST /login` 拿 token，缓存到内存/本地存储。
2. `GET /sources` 拉取可订阅源，渲染 UI。
3. `POST /sessions` 创建会话（按用户选择传入 `sources`）。
4. `GET /read_cached_content?source=...` 拉历史快照，先渲染已有内容。
5. `GET /events?session=...` 建立 SSE，消费增量。
6. 用户切换订阅 → `PUT /sessions/{id}/sources`（SSE 无需重连）。
7. 离开页面/登出 → `DELETE /sessions/{id}` + 关闭 EventSource。

### 9.2 session 过期处理

session 空闲超过 `session_ttl`（默认 1h）会被服务端回收，之后 SSE 拿该 session 连接会返回 `401`。建议：

- SSE 正常连接时，服务端心跳会在 `ping` 时刷新会话活性，只要连接在，session 一般不会过期。
- 断网或页面长时间挂起导致连接断开，超过 TTL 后重连会失败；此时应重新 `createSession` 并重开 SSE。

### 9.3 断线续传

- 服务端在 SSE 中携带单调递增的 `id` 字段，可用它检测是否有事件丢失（如 `lastId + 1 != newId`）。
- 服务端**不提供事件回放**（当前实现无 Last-Event-ID 续传）。若发现断档，请用 `read_cached_content` 重新拉取全量快照校准。
- 每条消息带 `offset`（文件字节位），跨文件可配合快照做对齐参考。

### 9.4 token 过期处理

token 默认 24h 有效。控制面请求收到 `401` 时，通常是 token 过期或服务重启（若服务端未配置固定 `token_secret`）。策略：捕获 `401` → 重新 `POST /login` → 用新 token 重试（会话也需重建）。

### 9.5 CORS

服务端对 `/events`、`/read_cached_content` 及 OPTIONS 预检均返回：

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Authorization, Content-Type
```

跨域前端可直接调用。若自建网关代理，注意 SSE 需关闭缓冲（服务端已带 `X-Accel-Buffering: no`）。

### 9.6 性能与背压

- 服务端每订阅连接有 256 条缓冲；日志洪峰时，慢消费者会被**丢弃事件**（不阻塞采集）。若前端处理能力不足，可减少订阅源数量或在 `onEvent` 里做批量节流。
- `raw` 模式按 ≤32KB/块推送，块本身是 base64（约 4/3 膨胀），前端注意分块重组。

---

## 10. 常见问题

**Q1：EventSource 连接后一直收不到事件？**
确认：① 是否带正确的 `session`；② 建会话时 `sources` 是否非空且包含目标源；③ 该用户 ACL 是否覆盖目标源（登录返回的 `sources` 可见）。

**Q2：`401 用户不存在或密码错误` 但密码是对的？**
可能原因：token 过期、服务端重启（未配置固定 `token_secret` 导致旧 token 失效）、或访问的用户无权限的源/路径。请重新登录并重建会话。

**Q3：`message` 字段为空？**
这是 `raw` 模式消息，内容在 `data`（base64），需按 `encoding` 解码。

**Q4：如何实现「先显示历史、再实时滚动」？**
先 `read_cached_content` 拿 `content` 渲染历史，再开 SSE 追加增量；用 `offset` 参考对齐点避免重复。

**Q5：切换订阅源需要断开 SSE 吗？**
不需要。调 `PUT /sessions/{id}/sources` 即可，服务端实时调整推送。

**Q6：多端（一个用户多个页面）互不影响吗？**
是。每个页面建独立 session，各自订阅、各自接收，互不干扰。

**Q7：如何安全存储 token？**
控制面调用建议用 `Authorization: Bearer` 头；SSE 由于 EventSource 限制只能用 `session` 查询参数（session 本身是随机高熵字符串，作用域仅为日志流）。生产环境建议全程 HTTPS。