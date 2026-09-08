# 工作区文件/目录上传下载接口设计

本文档描述 log_gateway_server 中间服务原生的文件/目录上传、下载接口。
所有接口基于 session 工作区（workspace root）操作，路径均为 **workspace root 相对路径**，
与「工作区文件树同步」（`doc/web_api.md` 第 10 章）中的 `path` 字段一致。

## 1. 概览

| 接口 | 方法 | 用途 |
|------|------|------|
| `/api/workspace/file/upload` | POST | 上传一个或多个文件（multipart），支持保留子目录结构 |
| `/api/workspace/directory/upload` | POST | 上传 zip 压缩包并解压到工作区（目录整体上传） |
| `/api/workspace/file/download` | GET | 下载单个文件 |
| `/api/workspace/directory/download` | GET | 将目录（或多个路径）打包为 zip 下载 |

- 路由注册在 `/api/` 后端反代之前，Go 1.22+ ServeMux 按模式特异性精确匹配，不转发后端。
- 上传/下载完成后，文件树同步（filewatch）会自动在 SSE `file` 事件流中推送 `changes`，
  前端无需手动刷新树。
- agent 未启用或 workspace root 未配置时返回 `503`。

## 2. 通用约定

### 2.1 鉴权与 session 归属

- 请求头：`Authorization: Bearer <gateway token>`（登录接口获取）。
- `session_id` 为必填 query 参数；token 对应用户必须拥有该 session，否则 `401`。
- 鉴权关闭（`auth.enabled=false`）时跳过 token 校验，session 必须存在。

### 2.2 路径约定

- 所有 `path` 参数为 **workspace root 相对路径**（如 `run/hello.py`、`assets/data`），支持嵌套。
- 空 `path`（上传时）表示 workspace root 本身。
- 路径穿越防护：`path` 含 `..` 组件、绝对路径（以 `/` 开头）、盘符前缀（含 `:`）一律 `400`。
- workspace root 结构：`<workspace_root>/<user>/<session_id>`。

### 2.3 错误码

| 状态码 | 场景 |
|--------|------|
| `400` | 参数缺失 / 路径穿越 / 目标不是目录 / multipart 无文件 / zip 非法 |
| `401` | 无 token / token 无效 / 越权访问他人 session |
| `404` | session 不存在 / 文件不存在 / 无可下载内容 |
| `413` | 请求体超过大小限制 |
| `503` | agent 未启用 / workspace root 未配置 |

## 3. 文件上传 `POST /api/workspace/file/upload`

### 3.1 请求

```
POST /api/workspace/file/upload?session_id=<sid>&path=<目标目录，可选>
Content-Type: multipart/form-data
Authorization: Bearer <token>
```

- `path`（可选）：目标目录（workspace root 相对），缺省为 workspace root；不存在时自动创建。
- 表单中包含 **一个或多个文件 part**（field 名任意，如 `file` / `files`）。
- 文件 part 的 `filename` 可携带相对子路径（浏览器 `webkitdirectory` 风格），
  如 `filename="run/step1/in.csv"` → 写入 `<root>/<目标目录>/run/step1/in.csv`；
  子目录自动创建。
- 同名文件直接覆盖。

浏览器 JS 示例（多选 / 目录拖拽）：

```js
const fd = new FormData();
for (const f of files) fd.append("files", f, f.webkitRelativePath || f.name);
await fetch(
  `${BASE}/api/workspace/file/upload?session_id=${sid}`,
  { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd }
);
```

### 3.2 响应 `200`

```json
{
  "root": "/srv/sciflow/admin/<sid>",
  "uploaded": [
    { "path": "run/step1/in.csv", "size": 10 },
    { "path": "run/step1/notes.md", "size": 9 }
  ]
}
```

| 字段 | 说明 |
|------|------|
| `root` | workspace root 绝对路径 |
| `uploaded[].path` | workspace root 相对路径 |
| `uploaded[].size` | 写入字节数 |

## 4. 目录上传 `POST /api/workspace/directory/upload`

### 4.1 请求

```
POST /api/workspace/directory/upload?session_id=<sid>&path=<目标目录，可选>
Content-Type: application/zip          （或 multipart/form-data，取第一个文件 part）
Authorization: Bearer <token>
```

- 请求体为 zip 压缩包：支持 raw body（`application/zip`）或 multipart 第一个文件 part。
- `path`（可选）：解压目标目录，缺省为 workspace root；不存在时自动创建。
- 前端目录上传方案：用 JSZip / fflate 等在前端把目录打包后上传，或直接拖拽 zip 文件。

### 4.2 安全处理

- **zip-slip 防护**：条目名含 `..` 组件、绝对路径、盘符前缀 → 整个请求 `400`，不做部分解压。
- **symlink 条目跳过**：zip 中符号链接条目不创建（防止指向工作区外），计数在 `skipped_symlinks`。
- **预校验**：解压前统计文件数/总字节数，超限直接 `413`，不产生部分解压结果。
- 解压后的文件权限 `0644`、目录 `0755`。

### 4.3 响应 `200`

```json
{
  "root": "/srv/sciflow/admin/<sid>",
  "extracted": 42,
  "total_bytes": 1048576,
  "skipped_symlinks": 1
}
```

| 字段 | 说明 |
|------|------|
| `extracted` | 解压出的文件数（不含目录） |
| `total_bytes` | 解压写入总字节数 |
| `skipped_symlinks` | 跳过的符号链接条目数 |

## 5. 文件下载 `GET /api/workspace/file/download`

### 5.1 请求

```
GET /api/workspace/file/download?session_id=<sid>&path=run/hello.py
Authorization: Bearer <token>
```

- `path`（必填）：workspace root 相对文件路径。
- 若 `path` 是目录 → `400`，提示使用 directory/download。

### 5.2 响应

- `Content-Type`：扩展名映射（同文件内容接口），未识别时按前 512 字节嗅探。
- `Content-Disposition: attachment; filename=<basename>`（RFC 5987 转义）。
- 通过 `http.ServeContent` 输出，**支持 Range / 断点续传**与 `If-Modified-Since`。
- `404`：文件不存在。

## 6. 目录下载 `GET /api/workspace/directory/download`

### 6.1 请求

```
GET /api/workspace/directory/download?session_id=<sid>&path=assets/data
或
GET /api/workspace/directory/download?session_id=<sid>&paths=hello.py,run/step1
Authorization: Bearer <token>
```

- `path`：单个目录（或单个文件）路径。
- `paths`（可选，优先于 `path`）：逗号分隔的多个相对路径（文件与目录可混用）。
- 目录打包时跳过 `.git` 与符号链接，保留空目录结构。

### 6.2 响应

- `Content-Type: application/zip`，流式打包输出（不落盘、不整体驻内存）。
- `Content-Disposition: attachment; filename=<name>.zip`
  （单个 `path` 时以路径末段命名，如 `data.zip`；多选为 `workspace.zip`）。
- **zip 条目为 workspace root 相对路径**（如 `assets/data/model/train.py`），
  因此该 zip 可直接通过 `/api/workspace/directory/upload` 回传并还原到相同位置。
- 超出条目/字节上限时停止打包并返回部分 zip（仍是合法 zip），响应头
  `X-Archive-Truncated: true` 标识。
- 无可打包内容（如路径为空目录且含空目录）时返回 `404`。

## 7. 大小与数量限制

通过配置文件 `workspace` 段控制（缺省用默认值）：

| 配置项 | 默认 | 说明 |
|--------|------|------|
| `workspace.upload_max_bytes` | 100 MB | file/upload 请求体上限（超限 `413`） |
| `workspace.archive_max_bytes` | 512 MB | directory/upload 压缩包体积上限（超限 `413`） |
| `workspace.extract_max_files` | 10000 | 单个 zip 解压文件数上限 |
| `workspace.extract_max_bytes` | 2 GB | 单个 zip 解压总字节上限 |
| `workspace.zip_max_entries` | 20000 | directory/download 打包条目数上限 |
| `workspace.zip_max_bytes` | 2 GB | directory/download 打包总字节上限 |

配置示例：

```json
{
  "workspace": {
    "upload_max_bytes": 104857600,
    "archive_max_bytes": 536870912,
    "extract_max_files": 10000,
    "extract_max_bytes": 2147483648,
    "zip_max_entries": 20000,
    "zip_max_bytes": 2147483648
  }
}
```

## 8. 安全设计要点

1. **鉴权前置**：所有接口先验 token、session 存在性、session 归属（与 `/sessions/{id}/*` 一致）。
2. **双重路径防护**：上传文件名 / zip 条目名先经 `sanitizeUploadRel` 拒绝 `..`/绝对路径/盘符，
   再经 `resolveWorkspacePath` 做词法 containment 校验（拼接后必须仍在目标目录内）。
3. **请求体硬上限**：`http.MaxBytesReader` 截断超限请求体，超限返回 `413`（`http.MaxBytesError` 映射）。
4. **zip 双重防护**：上传先预校验（计数/字节）再解压，避免部分解压；条目名逐项校验；
   符号链接条目跳过。
5. **下载不可逃逸**：`path` 同样走 `resolveWorkspacePath`，无法读取 workspace root 之外的文件。

## 9. 与文件树同步的联动

上传/下载不直接操作文件树同步器；filewatch 按 `agent.file_sync_interval`（默认 3s）
轮询，检测到变化后自动通过 SSE 推送：

```
event: file
data: {"type":"changes","changes":[{"path":"run/step1/in.csv","kind":"added"}]}
```

前端在上传成功后无需刷新文件树，等待 `changes` 事件即可。
