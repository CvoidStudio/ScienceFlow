# log_gateway_server 启动与 Agent 工程配合配置指南

本文档说明 `log_gateway_server`（下称 **lgw**）如何编译、启动、配置，以及如何与 ScienceFlow Agent 工程配合工作，包括环境变量、目录布局、鉴权、agent 子进程调用链等运维要点。

> 前端对接 API 见 `doc/web_api.md`；Agent 工程本身的启动方式见 `doc/agent_launch.md`。

## 目录

1. [整体架构与调用链](#1-整体架构与调用链)
2. [环境要求](#2-环境要求)
3. [编译](#3-编译)
4. [启动](#4-启动)
5. [配置详解（config.json）](#5-配置详解configjson)
6. [与 ScienceFlow Agent 工程配合](#6-与-scienceflow-agent-工程配合)
7. [用户鉴权（AUTH.yaml）](#7-用户鉴权authyaml)
8. [运行时目录布局](#8-运行时目录布局)
9. [并发与队列](#9-并发与队列)
10. [运维要点](#10-运维要点)
11. [常见问题排查](#11-常见问题排查)

---

## 1. 整体架构与调用链

```
                    ┌──────────────────────────────────────────────┐
前端 ──HTTP/SSE──►  │ log_gateway_server                            │
                    │  ├─ 鉴权（AUTH.yaml → HMAC token）             │
                    │  ├─ 会话订阅 + 源级 ACL                        │
                    │  ├─ tailer：监控日志文件 → SSE 推送             │
                    │  ├─ agent runner：调用 scienceflow CLI 子进程   │
                    │  └─ /api/* 反代 → backend.url                  │
                    └──────────────┬───────────────────────────────┘
                                   │ subprocess
                                   ▼
              python -m scienceflow.cli repl \
                -m <ws>/<session>/gateway_manifest.yaml \
                --auto-first-user --exit-after-auto --plain
                                   │
                                   ▼
              ScienceFlow Agent（不改后端代码）
                workspace: $SCIFLOW_WORKSPACE_ROOT/<user>/<session>/run/
                stdout ──► $SCIFLOW_WORKSPACE_ROOT/task_logs/<user>/<session>/RAW.log
                                   │
                                   ▼（tailer 100ms poll）
              SSE event: log ──► 前端实时显示
```

**核心机制**：lgw 收到 `POST /sessions/{id}/invoke` 后：

1. 在 `$SCIFLOW_WORKSPACE_ROOT/<user>/<session>/` 下生成一次性 manifest（`gateway_manifest.yaml`）与首问文件（`gateway_first_user.txt`）
2. 以子进程方式启动 `python -m scienceflow.cli repl --auto-first-user --exit-after-auto -m <manifest> --plain`
3. 子进程 stdout/stderr 实时写入 `task_logs/<user>/<session>/RAW.log`（append 模式）
4. lgw 内置 tailer 监听该文件（源名 `agent-logs`），新增行经 SSE 推送前端
5. 同 session 重复 invoke 时，ScienceFlow 自动加载已有 memory，实现多轮对话

## 2. 环境要求

| 项 | 要求 |
|----|------|
| Go | ≥ 1.22（编译 lgw；仅依赖 `gopkg.in/yaml.v3`） |
| Python | ≥ 3.11（运行 ScienceFlow，已 `uv sync` 安装 `.venv`） |
| 环境变量 | `SCIFLOW_WORKSPACE_ROOT`（agent 工作区根，见 §6.1），或在 config.json 里配置 `agent.workspace_root` 覆盖 |
| ScienceFlow `.env` | `API_KEY`、`BASE_URL`、`CODE_MODEL`、`FEEDBACK_MODEL`（LLM 端点，Agent 运行必需） |

Go 模块代理（国内网络建议）：

```bash
export GO111MODULE=on
export GOPROXY=https://goproxy.cn,direct
```

## 3. 编译

```bash
cd log_gateway_server

# 当前平台
go build -o lgw .

# 交叉编译（示例：Windows → 目标 Linux amd64）
GOOS=linux GOARCH=amd64 go build -o lgw .
# Windows PowerShell:
# $env:GOOS="linux"; $env:GOARCH="amd64"; go build -o lgw .; Remove-Item Env:GOOS,Env:GOARCH
```

产物为单一静态二进制（约 11MB），无运行时依赖。

> `go.mod` 声明 `go 1.22`；若本机工具链更新（如 go 1.24+），可直接编译，无需改动。

## 4. 启动

### 4.1 前台运行

```bash
# 工作目录必须是 lgw 所在目录（相对路径的 AUTH.yaml / registry 依赖它）
cd log_gateway_server

# Linux
export SCIFLOW_WORKSPACE_ROOT=/data/sciflow_workspaces   # agent 工作区根（见 §6.1）
./lgw -config config.json

# Windows
$env:SCIFLOW_WORKSPACE_ROOT="D:\data\sciflow_workspaces"
.\lgw.exe -config config.json
```

唯一命令行参数：

| 参数 | 默认 | 说明 |
|------|------|------|
| `-config` | `config.json` | 配置文件路径 |

### 4.2 后台 / 守护运行

```bash
# Linux：nohup 脱离终端
nohup ./lgw -config config.json > lgw.out.log 2>&1 &

# Linux：setsid 脱离信号组（推荐，避免父 shell 退出连带杀掉）
setsid ./lgw -config config.json > lgw.out.log 2>&1 < /dev/null &

# Linux 生产：systemd 单元（示例）
# [Service]
# WorkingDirectory=/opt/log_gateway_server
# Environment=SCIFLOW_WORKSPACE_ROOT=/data/sciflow_workspaces
# ExecStart=/opt/log_gateway_server/lgw -config /opt/log_gateway_server/config.json
# Restart=on-failure

# Windows：Start-Process
Start-Process -FilePath .\lgw.exe -ArgumentList "-config","config.json" `
  -WorkingDirectory (Get-Location) `
  -RedirectStandardOutput "lgw.out.log" -RedirectStandardError "lgw.err.log"

# Windows 服务：用 NSSM / WinSW 包裹 lgw.exe
```

### 4.3 停止

```bash
# 优雅退出：SIGTERM / Ctrl+C
# 收到信号后 lgw 会：关闭 HTTP → 停止所有 harvester → registry 检查点落盘 → 退出
kill <pid>          # Linux
Stop-Process -Name lgw   # Windows
```

> 注意：优雅退出**不会**等待正在运行的 agent 子进程结束；子进程会随 lgw 退出而被终止（exec.CommandContext 级联）。运行中的任务 workspace 与 memory 已落盘，重新 invoke 可续跑。

### 4.4 启动成功标志

日志输出（stdout）：

```
[log_gateway] 2026/09/02 03:04:19 auth enabled: 2 user(s) from AUTH.yaml; token_secret empty, using ephemeral secret
[log_gateway] 2026/09/02 03:04:19 agent invocation enabled: python=python3 module=scienceflow.cli command=repl repo=/scienceflow max_concurrent=4 max_queue=16
[log_gateway] 2026/09/02 03:04:19 listening on http://127.0.0.1:8080   SSE endpoint: /events
```

验证：

```bash
curl http://127.0.0.1:8080/healthz
# {"status":"ok","subscribers":0}
```

## 5. 配置详解（config.json）

完整示例（`log_gateway_server/config.json`）：

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 8080,
    "sse_path": "/events"
  },
  "auth": {
    "enabled": true,
    "file": "AUTH.yaml",
    "token_secret": "",
    "token_ttl": "24h",
    "session_ttl": "1h"
  },
  "backend": {
    "url": "http://127.0.0.1:8200"
  },
  "agent": {
    "enabled": false,
    "python": "uv run python",
    "module": "scienceflow.cli",
    "command": "repl",
    "config_yaml": "scienceflow/config/default.yaml",
    "repo_root": "/scienceflow",
    "workspace_root": "",
    "input_data_dir": "",
    "exp_id": "",
    "timeout": "3600s",
    "max_concurrent": 4,
    "max_queue": 16,
    "log_dir_name": "task_logs"
  },
  "inputs": [ ... ],
  "registry": { "path": "./data/registry.json", "flush_interval": "5s" },
  "scan": { "frequency": "5s" }
}
```

### 5.1 server

| 字段 | 默认 | 说明 |
|------|------|------|
| `server.host` | `0.0.0.0` | 监听地址 |
| `server.port` | `8080` | 监听端口 |
| `server.sse_path` | `/events` | SSE 端点路径 |

### 5.2 auth

| 字段 | 默认 | 说明 |
|------|------|------|
| `auth.enabled` | `false` | 是否开启鉴权（生产必开） |
| `auth.file` | `AUTH.yaml` | 账密文件路径（相对工作目录） |
| `auth.token_secret` | 空 | HMAC 签名密钥。**留空则每次启动随机生成，重启后所有 token 失效**；生产应固定 |
| `auth.token_ttl` | `24h` | token 有效期 |
| `auth.session_ttl` | `1h` | 会话空闲过期时间 |

### 5.3 backend

| 字段 | 默认 | 说明 |
|------|------|------|
| `backend.url` | `http://127.0.0.1:8200` | `/api/*` 反代目标（ScienceFlow 后端 HTTP 服务，如未部署则保持默认即可，不影响其他功能） |

### 5.4 agent（与 Agent 工程配合的核心段）

| 字段 | 默认 | 说明 |
|------|------|------|
| `agent.enabled` | `false` | agent 调用总开关 |
| `agent.python` | `python` | 解释器命令。用 uv 管理的环境填 `uv run python`；直装填 `python3` |
| `agent.module` | `scienceflow.cli` | CLI 模块名（即 `python -m <module>`） |
| `agent.command` | `repl` | 子命令：`repl`（推荐）或 `run` |
| `agent.config_yaml` | 空 | 传给 CLI 的 `-c` 配置文件（相对 `repo_root`）。推荐 `scienceflow/config/default.yaml` |
| `agent.repo_root` | **必填**（enabled 时） | 子进程工作目录 = ScienceFlow 仓库根。相对路径相对于 lgw 启动时 cwd，**推荐绝对路径** |
| `agent.workspace_root` | 空 | 覆盖 `$SCIFLOW_WORKSPACE_ROOT`；为空时读环境变量（两者都为空则 invoke 报错） |
| `agent.input_data_dir` | 空 | 可选 `-d` 共享数据集根（会软链到各 workspace 的 `dataset/`） |
| `agent.exp_id` | 空 | 可选 `--exp-id` 覆盖 |
| `agent.timeout` | `3600s` | 单次任务 wall-clock 上限（**含排队等待时间**），超时自动 kill。`0` = 不限时 |
| `agent.max_concurrent` | `4` | 同时运行的 agent 子进程上限 |
| `agent.max_queue` | `16` | 并发满后的等待队列上限，超出返回 `503` |
| `agent.log_dir_name` | `task_logs` | workspace 下 scienceflow 自身日志子目录名 |

> **`agent.enabled=true` 时的校验规则**（启动即失败）：
> - `repo_root` 必填
> - `command` 只能是 `repl` 或 `run`
> - `SCIFLOW_WORKSPACE_ROOT` 或 `agent.workspace_root` 至少一个非空（否则启动警告、invoke 报错，且 RAW.log 不会被 tail）

### 5.5 inputs（日志采集源）

每个 input 定义一个被监控的文件 glob。**agent 功能开启时，lgw 自动追加一个内置 input**（无需手配）：

```json
{
  "name": "agent-logs",
  "path": "$SCIFLOW_WORKSPACE_ROOT/task_logs/*/*/RAW.log",
  "mode": "line",
  "tail_files": true,
  "poll_interval": "100ms"
}
```

常规 input 字段：

| 字段 | 默认 | 说明 |
|------|------|------|
| `inputs[].name` | 路径本身 | 源逻辑名（SSE 过滤 / ACL 用） |
| `inputs[].path` | 必填 | glob 模式 |
| `inputs[].mode` | `line` | `line` / `prefix` / `raw` |
| `inputs[].tail_files` | `false` | `true` 只读新增；`false` 首次回放历史全文 |
| `inputs[].poll_interval` | `250ms` | EOF 轮询间隔（实时性关键） |
| `inputs[].prefix_format` | — | `mode=prefix` 必填，strftime 语法 |
| `inputs[].ignore_older` | `0s` | 忽略超过该时长的文件 |
| `inputs[].multiline.*` | — | line 模式多行合并（pattern/negate/match/timeout） |

> 注意：`inputs` 数组**至少一项**（启动校验），纯 agent 用途可配一个占位 glob。

### 5.6 registry / scan

| 字段 | 默认 | 说明 |
|------|------|------|
| `registry.path` | `data/registry.json` | 采集 offset 检查点文件 |
| `registry.flush_interval` | `5s` | 检查点落盘间隔 |
| `scan.frequency` | `10s` | 新文件发现周期 |

## 6. 与 ScienceFlow Agent 工程配合

### 6.1 目录约定

lgw 与 Agent 工程通过 `SCIFLOW_WORKSPACE_ROOT` 解耦：

```
$SCIFLOW_WORKSPACE_ROOT/            ← 环境变量或 agent.workspace_root
├── <user_id>/                      ← gateway 登录用户名
│   └── <session_id>/               ← gateway 会话 ID（32 位 hex）
│       ├── gateway_manifest.yaml   ← 每次 invoke 生成的一次性 manifest
│       ├── gateway_first_user.txt  ← 用户消息原文（首问文件）
│       └── run/                    ← ScienceFlow 实际执行目录（workspace_base/run_id/exp_id 解析而来）
│           ├── dataset/            ← （可选）input_data_dir 软链
│           ├── logs/               ← scienceflow 自身日志
│           ├── memory/             ← agent 对话 memory（跨 invoke 保留 → 多轮）
│           ├── description.md
│           └── submissions/
└── task_logs/
    └── <user_id>/
        └── <session_id>/
            └── RAW.log             ← agent stdout 实时追加（SSE 数据源）
```

### 6.2 生成的 manifest 内容

每次 invoke 在 `<root>/<user>/<session>/gateway_manifest.yaml` 生成：

```yaml
defaults:
  repl_auto_first_user: true
  repl_exit_after_auto: true
  repl_profile: lite
  repl_first_user_query_file: /root/<user>/<session>/gateway_first_user.txt
  workspace_base: /root/<user>
tasks:
  - exp_id: run
    run_id: <session_id>
    task: "<用户消息>"
    input_data_dir: /data/datasets    # 仅当 agent.input_data_dir 非空
```

> ScienceFlow 的 workspace 解析规则是 `workspace_base/run_id/exp_id`，故执行目录为 `<root>/<user>/<session>/run`。

### 6.3 实际执行的子进程命令

```
cd <agent.repo_root>
python -m scienceflow.cli repl \
  -m <root>/<user>/<session>/gateway_manifest.yaml \
  [-c <agent.config_yaml>] \
  --auto-first-user --exit-after-auto --plain
```

- 子进程环境继承 lgw 进程环境，并强制注入 `SCIFLOW_WORKSPACE_ROOT`
- **ScienceFlow 的 `.env`（API_KEY/BASE_URL 等）由其自身 `bootstrap_dotenv` 在启动时加载**（相对 `repo_root`），因此 lgw 无需转发 LLM 凭据
- `--auto-first-user --exit-after-auto`：跑完一轮首问即退出（参考 `doc/agent_launch.md` §2）
- 多轮对话：同一 session 再次 invoke → ScienceFlow 检测到 workspace 已有 memory → 自动加载续聊

### 6.4 推荐配合配置（完整示例）

假设 ScienceFlow 仓库在 `/opt/scienceflow`，工作区根在 `/data/sciflow_ws`：

```bash
# 1. ScienceFlow 侧准备（一次性）
cd /opt/scienceflow
uv sync                                # 安装依赖
# 编辑 .env：API_KEY / BASE_URL / CODE_MODEL / FEEDBACK_MODEL

# 2. 启动 lgw
export SCIFLOW_WORKSPACE_ROOT=/data/sciflow_ws
cd /opt/log_gateway_server
setsid ./lgw -config config.json > lgw.out.log 2>&1 < /dev/null &
```

config.json 关键段：

```json
{
  "agent": {
    "enabled": true,
    "python": "uv run python",
    "module": "scienceflow.cli",
    "command": "repl",
    "config_yaml": "scienceflow/config/default.yaml",
    "repo_root": "/opt/scienceflow",
    "workspace_root": "",
    "timeout": "3600s",
    "max_concurrent": 4,
    "max_queue": 16,
    "log_dir_name": "task_logs"
  }
}
```

> `python` 字段的选择：
> - ScienceFlow 用 uv 管理（有 `uv.lock` / `.venv`）→ `uv run python`（推荐，自动使用锁定环境）
> - 系统直装 → `python3`
> - 注意 `uv run` 需要 `repo_root` 下有 `pyproject.toml`

### 6.5 LLM 配置传递链

```
lgw 不管理 LLM 凭据
  └─ 子进程启动（继承 lgw 环境 + SCIFLOW_WORKSPACE_ROOT）
       └─ scienceflow.cli 入口 bootstrap_dotenv(repo_root)
            └─ 加载 /opt/scienceflow/.env → API_KEY / BASE_URL / CODE_MODEL ...
```

修改 `.env` 后**无需重启 lgw**——每次 invoke 都是新子进程，自动读取最新 `.env`。

## 7. 用户鉴权（AUTH.yaml）

位置由 `auth.file` 指定（默认相对 lgw 工作目录）。两种写法：

```yaml
# 1) 简化写法：只有密码，可读所有日志源
admin: admin123

# 2) 完整写法：指定可读源（sources 为 inputs[].name 列表，或 ["*"] 全量）
viewer:
  password: viewer456
  sources: ["agent-logs", "plain-text"]
```

- `sources` 控制**日志订阅 ACL**；agent invoke 权限跟随 session 归属（只能操作自己的 session）
- `token_secret` 生产环境必须固定，否则重启后所有前端 token 失效（表现为集体 401）

## 8. 运行时目录布局

lgw 自身工作目录（`= 启动时 cwd`）：

```
log_gateway_server/
├── lgw / lgw.exe        # 二进制
├── config.json
├── AUTH.yaml
├── data/
│   └── registry.json    # 采集 offset 检查点（重启续读）
└── logs/                # 示例日志（inputs 演示用）
```

## 9. 并发与队列

多用户远端并发场景的调度模型：

```
invoke ──► [队列 chan，容量 max_queue]
                │  满 → 503 拒绝（含 queued/running 统计）
                ▼
          dispatcher（单 goroutine）
                │  running 数 < max_concurrent 时取出
                ▼
          子进程启动（StatusRunning）
                │ 结束/超时/kill
                ▼
          finalize → 释放 slot → dispatcher 补位
```

| 机制 | 行为 |
|------|------|
| 全局并发上限 | `max_concurrent`（默认 4），超出排队 |
| 队列上限 | `max_queue`（默认 16），超出 invoke 返回 `503` + `{queued, running}` |
| per-session 串行 | 同 session 有 queued/running 任务时 invoke 返回 `409` |
| 任务超时 | `timeout` 覆盖排队等待 + 执行全程，超时 kill 子进程 |
| 队列可见性 | `GET /sessions/{id}/agent` 响应含 `queue_stats: {queued, running}` |

**容量规划建议**：单个 agent 子进程 = 1 个 LLM 会话 + 工具执行，主要瓶颈在 LLM API 并发与主机 CPU（agent 可能跑训练代码）。`max_concurrent` 建议从 LLM API 配额的 1/2 起步，观察 503 频率再调。

## 10. 运维要点

1. **registry 持久化**：`data/registry.json` 记录各日志文件采集 offset，重启后无漏无重。容器部署时挂 volume。
2. **优雅退出**：SIGTERM 触发检查点落盘；agent 子进程被级联终止（memory 已落盘可续跑）。
3. **单实例部署**：lgw 无状态（除 registry），但多实例读同一批日志会重复推送；agent runner 的队列/并发限制也是进程内的，**通常单实例**。
4. **反向代理**：前端经 Nginx/Caddy 访问时，SSE 需关闭代理缓冲（lgw 已内置 `X-Accel-Buffering: no`），并放宽 `proxy_read_timeout`（建议 ≥ 24h 或按 session_ttl）。
5. **HTTPS**：生产建议全程 HTTPS（token 经查询参数传递时尤其重要）。
6. **磁盘**：RAW.log 无限累积（append 模式）；`$SCIFLOW_WORKSPACE_ROOT` 需按用户量 × 任务量规划容量，必要时外部 logrotate（lgw 支持轮转检测，copytruncate 方式即可）。
7. **日志查看**：lgw 自身日志在 stdout（`[log_gateway]` 前缀），重定向到文件即可。

## 11. 常见问题排查

| 现象 | 原因与处理 |
|------|-----------|
| 启动报 `agent.repo_root is required` | `agent.enabled=true` 但未配 `repo_root` |
| 启动报 `at least one input is required` | `inputs` 数组为空，加一个占位 glob |
| 启动警告 `SCIFLOW_WORKSPACE_ROOT not set` | 环境变量与 `agent.workspace_root` 都为空：invoke 会报错，RAW.log 不会推送 |
| invoke 报 `SCIFLOW_WORKSPACE_ROOT is not set...` | 同上，二选一配置 |
| invoke 后任务 `failed`，output 含 `No module named scienceflow` | `python` 选错解释器；改 `uv run python` 或激活正确 venv |
| 任务 failed，output 含 `need non-empty 'workspace' or 'workspace_base'` | manifest 生成异常（旧版本 bug），确认使用最新编译的 lgw |
| 任务 failed，output 含 LLM 连接错误 | 检查 ScienceFlow `.env` 的 `API_KEY`/`BASE_URL`；`.env` 相对 `repo_root` 生效 |
| agent 输出前端看不到（SSE 无 event） | ① session 是否订阅了 `agent-logs` 源；② 用户 ACL 是否含 `agent-logs`；③ `SCIFLOW_WORKSPACE_ROOT` 是否在 lgw 启动前设置（tailer glob 依赖它） |
| 前端集体 401 | lgw 重启且 `token_secret` 未固定 → 重新登录 |
| invoke 返回 503 | 队列满：调大 `max_queue` 或 `max_concurrent`，或前端退避重试 |
| invoke 返回 409 | 同 session 已有任务在跑：等完成或先 `DELETE /sessions/{id}/agent` |
| registry.json 残留其他机器路径 | 换机器/换目录部署时删除 `data/registry.json` 重新采集 |
