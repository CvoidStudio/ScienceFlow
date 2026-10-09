## ScienceFlow 网关服务 + 桌面客户端

本分支（`app`）是 ScienceFlow 的**应用发行分支**，包含两个可独立构建、协同工作的组件：

| 组件 | 目录 | 说明 | 技术栈 |
|---|---|---|---|
| 日志/任务网关 | [`log_gateway_server/`](log_gateway_server/) | 多用户鉴权、会话管理、日志 SSE 实时推流，并负责按需拉起 ScienceFlow 智能体子进程 | Go（单二进制） |
| 桌面控制台 | [`web_app/`](web_app/) | Agent Map、对话轨迹、工作区文件、监控面板 | Wails v3 + React 18 + Vite 6 |

> **ScienceFlow 智能体**（研究框架本体）通过 pip 分发，安装命令：`pip install scienceflow`。
> 网关在启动引导阶段会自动检测并（可选）安装/更新它。

---

## 架构与数据流

```text
                       pip install scienceflow
  ┌────────────────┐  ◀──────────────────────────────  ┌───────────────────────┐
  │ ScienceFlow    │      子进程: python -m             │  log_gateway_server   │
  │ Agent CLI      │      scienceflow.cli repl          │  ─ 鉴权 / 会话         │
  └───────┬────────┘                                    │  ─ 日志 SSE 推流       │
          │ RAW.log / interaction.log                   │  ─ agent 任务调度      │
          ▼                                             └───────────┬───────────┘
  ┌────────────────┐                                                │ SSE + REST
  │ workspaces/    │  每用户/会话独立工作区                          ▼
  │ task_logs/...  │                                    ┌───────────────────────┐
  └────────────────┘                                    │  web_app (Wails v3)   │
                                                        │  桌面控制台（前端 UI） │
                                                        └───────────────────────┘
```

1. 用户在桌面端发送消息，网关在 `workspaces/<user>/<session>/` 下生成运行清单并拉起安装版 ScienceFlow 智能体；
2. 智能体运行过程中的 stdout/stderr 与完整交互记录分别写入 `task_logs/<user>/<session>/RAW.log` 与 `<session>/run/.logs/interaction.log`；
3. 网关监听这两个文件，经 SSE 实时推送给已订阅的桌面端会话；桌面端解析日志重建对话与执行轨迹（Agent Map、消息块、监控面板）。

---

## 环境要求

| 依赖 | 版本 | 用途 |
|---|---|---|
| Python + pip | 3.11+ | 运行 ScienceFlow 智能体（`pip install scienceflow`） |
| Go | 网关 1.22+；桌面端 1.25+ | 编译网关与桌面应用 |
| Node.js + npm | 20 LTS+ | 构建桌面端前端 |
| [Wails v3 CLI](https://v3.wails.io) | `v3.0.0-beta.25` | 构建桌面应用 |
| NSIS（可选） | 任意近期版本 | `wails3 package` 生成 Windows 安装包 |
| WebView2 Runtime | — | 桌面应用运行时（Windows 10/11 通常已内置） |

安装 Wails CLI（版本需与 `web_app/go.mod` 一致）：

```bash
go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.25
```

---

## 一、安装 ScienceFlow 智能体

```bash
# 安装（当前发布通道为预发布版本，建议加 --pre）
pip install scienceflow
# 或：python -m pip install --pre scienceflow
```

验证安装：

```bash
python -c "import scienceflow, importlib.metadata as m; print(m.version('scienceflow'))"
```

网关的**启动引导**会自动完成检测、安装与更新（详见下文 `-bootstrap` / `-yes` 参数）：

```text
◆ [2/3] 检测 scienceflow 安装
  ⚠ 未检测到 scienceflow（包名 scienceflow）
  Python        /usr/local/bin/python (3.12.13)
  安装命令      python -m pip install --pre scienceflow
  ? 是否自动安装 scienceflow？ [Y/n]
```

> 若使用自定义解释器或 `uv`，请设置网关配置中的 `agent.python`（如 `"uv run python"`）。

---

## 二、构建并部署网关服务（log_gateway_server）

### 1. 构建

```bash
cd log_gateway_server

# Windows
go build -o lgw.exe .

# Linux（可交叉编译）
GOOS=linux GOARCH=amd64 go build -o lgw .
```

产物为**单一可执行文件**，无运行时依赖（registry 检查点除外，见下）。

### 2. 配置

网关读取 `config.json`（用 `-config` 指定路径），核心配置段：

```jsonc
{
  "server": { "host": "0.0.0.0", "port": 52001, "sse_path": "/events" },
  "auth":   { "enabled": true, "file": "AUTH.yaml", "token_ttl": "24h" },
  "agent": {
    "enabled": true,
    "python": "python",                 // 或 "uv run python"
    "workspace_root": "../workspaces",  // 工作区根目录（也可用环境变量 SCIFLOW_WORKSPACE_ROOT）
    "timeout": "3600s",
    "max_concurrent": 4
  },
  "inputs": [ /* 可选：样例日志源（prefixed-logs / raw-logs / plain-text） */ ],
  "registry": { "path": "./data/registry.json" }
}
```

用户账号位于 `AUTH.yaml`（与网关鉴权、桌面端登录共用）：

```yaml
admin: admin123            # 简化写法：可读所有源
sciflow: "123456"
# 完整写法（按源授权）：
# viewer:
#   password: viewer456
#   sources: ["prefixed-logs", "plain-text"]
```

> `inputs` 中的样例日志源仅用于演示 SSE 能力；对接智能体任务时必需的是 `agent` 段与 `agent-logs` 源（网关自动接管）。
> **部署前请务必修改 `AUTH.yaml` 中的示例口令。**

### 3. 运行

```bash
# 前台运行（交互式启动引导：检测/安装/更新 scienceflow）
./lgw.exe -config config.json

# 后台 / 服务化部署：跳过交互引导
./lgw.exe -config config.json -bootstrap=false

# 无人值守：自动确认安装/更新
./lgw.exe -config config.json -yes
```

健康检查：

```bash
curl http://127.0.0.1:52001/healthz
# {"status":"ok","subscribers":0}
```

### 4. 服务化部署

推荐的部署目录结构：

```text
gateway/
├── lgw.exe              # 网关二进制
├── config.json          # 网关配置（端口须与桌面端一致）
├── AUTH.yaml            # 用户账号
├── logs/                # 可选：演示日志源
├── data/registry.json   # 采集检查点（自动生成，建议持久化）
└── workspaces/          # 任务工作区根目录（见 agent.workspace_root）
```

- **Windows**：用 [NSSM](https://nssm.cc/) / WinSW 注册为服务（工作目录设为上述目录，参数 `-config config.json -bootstrap=false`），或 `Start-Process` 后台重定向日志；
- **Linux**：`systemd` 单元或 `nohup ./lgw -config config.json > lgw.out.log 2>&1 &`；
- 重启安全：采集 offset 持久化在 `registry.path`，优雅退出会落盘检查点，重启后无缝续读。

### 5. 生产部署要点

1. `registry.path` 指向持久化目录（容器场景挂载 volume）；
2. `inputs[].path` 使用绝对路径；
3. 对外暴露时经反向代理（Nginx/Caddy）加 TLS 与鉴权；SSE 已内置 `X-Accel-Buffering: no`；
4. 网关为单实例有状态（检查点），多实例共读同一批日志会导致重复推送。

> 完整配置字段、SSE 协议、控制面 API（`/login`、`/sessions/*`、`/models/*`、`/invoke` 等）见 **[log_gateway_server/README.md](log_gateway_server/README.md)**。

---

## 三、构建并部署桌面应用（web_app）

### 1. 开发模式

```bash
cd web_app
wails3 dev
```

- 热重载；前端源码在 `frontend/`，Go 侧在 `web_app/` 根目录；
- 开发构建脚本位于 `build/`（Wails 标准构建脚手架；该目录未入库，缺失时用 Wails CLI 恢复/初始化）；绑定代码由 `wails3 generate bindings -ts` 自动生成到 `frontend/bindings/`；
- **请勿**直接用浏览器打开 Vite 地址：Wails 运行时绑定不存在，接口不可用。

### 2. 生产构建

```bash
cd web_app
wails3 build            # 产物：bin/scienceflow_gui.exe（Windows）
wails3 package          # 生成 NSIS 安装包（需安装 makensis）
```

`wails3 build` 会依次完成：前端依赖安装 → TypeScript 绑定生成 → 前端构建（`frontend/dist`）→ 图标/版本资源（`build/config.yml` 的 `info` 段）→ Go 编译（`-tags production -H windowsgui`）。

#### 仅构建前端 dist（可选，无需 Wails CLI）

若只需要前端产物（CI 校验、或供其他流程嵌入），可独立构建；产物与 `wails3 build` 内嵌的完全一致（相同 `frontend/bindings`、相同输出目录 `frontend/dist`）：

```bash
cd web_app/frontend
npm ci                 # 或 npm install
npm run build:dist     # → frontend/dist
```

已安装 Wails CLI 时，也可从 `web_app/` 目录使用等价入口：

```bash
wails3 task build:frontend
```

> `frontend/bindings/` 为已入库的生成物，独立构建直接复用；若 Go 侧接口有变更，以 `wails3 build`（会自动重新生成绑定）为准。`frontend/dist` 被 Git 忽略；纯浏览器打开 `dist/index.html` 不可用（无 Wails 运行时，接口与 SSE 均不可达）。

### 3. 部署布局

```text
scienceflow-gui/
├── scienceflow_gui.exe
├── app_config.yaml          # 网关地址（与 exe 同目录，其次当前工作目录）
└── themes/
    └── backgrounds/         # 可选：Agent 地图背景图（文件名即设置中的选项名）
```

`app_config.yaml`：

```yaml
gateway: http://127.0.0.1:52001   # 必须与网关 config.json 的 server.port 一致
```

- 未找到配置文件时使用内置默认 `http://127.0.0.1:8080`，也可在应用内设置中运行时修改；
- `themes/backgrounds/` 目录在首次运行时自动创建，放入 PNG/JPG/WebP 等图片即可在「设置 → 背景图片」中选择；未放置时使用内置默认背景；
- 登录账号与网关 `AUTH.yaml` 一致（如示例 `admin / admin123`）。

### 4. 验证

1. 启动网关，`curl http://127.0.0.1:52001/healthz` 返回 `ok`；
2. 启动桌面应用，登录后打开「设置 → 测试连接」：仅探测网关连通性，顶栏状态指示同步显示 `已连接`；
3. 在对话面板发送消息，网关拉起智能体后，Agent Map、执行轨迹与「日志」页签将实时回放运行过程。

---

## 四、端到端快速开始（Linux 示例）

```bash
# 1) 安装智能体
python -m pip install --pre scienceflow

# 2) 构建并启动网关（首次启动自动校验 scienceflow）
cd log_gateway_server
go build -o lgw .
./lgw -config config.json -yes &
curl http://127.0.0.1:52001/healthz

# 3) 构建桌面应用并部署
cd ../web_app
wails3 build
mkdir -p dist && cp bin/scienceflow_gui.exe dist/
cp app_config.yaml dist/
# 将 dist/ 拷贝到目标机器运行（Windows 需 WebView2 Runtime）
```

---

## 仓库结构

```text
.
├── log_gateway_server/        # 网关服务（Go）
│   ├── main.go                # 入口：config / registry / hub / tailer / server 装配
│   ├── internal/              # auth / session / agent / tailer / server / hub ...
│   ├── config.json            # 示例配置（端口 52001）
│   └── AUTH.yaml              # 示例账号
├── web_app/                   # 桌面应用（Wails v3）
│   ├── main.go / app.go / gateway.go / proxy.go / themes.go ...
│   ├── build/                 # Wails 构建脚手架（Taskfile、图标、info.json）
│   ├── frontend/              # React + Vite 前端（src/、bindings/）
│   ├── app_config.yaml        # 网关地址
│   └── Taskfile.yml           # build / dev / package 入口
├── workspaces/                # 运行期任务工作区（不入库）
└── data/                      # 运行期数据（不入库）
```

## 测试

```bash
cd log_gateway_server && go test ./...
cd ../web_app && go test ./...          # themes 解析等单元测试
cd frontend && npm run typecheck        # 前端类型检查
```

## 相关文档

- [log_gateway_server/README.md](log_gateway_server/README.md)：网关完整配置、鉴权与会话模型、SSE 消息格式、agent 调度与 `/models` registry 对接；
- [web_app/README.md](web_app/README.md)：桌面端架构与实现细节；
- ScienceFlow 框架源码与论文：<https://arxiv.org/abs/2608.14354>。

## License

[MIT License](LICENSE)
