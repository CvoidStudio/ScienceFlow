# ScienceFlow 后端智能体启动方式

> 源工程：`D:\work\Huawei\science_flow_app\sciflow_opensource`
>
> CLI 入口：`scienceflow/cli.py`（`python -m scienceflow.cli <command>`）
>
> 运行依赖：Python 3.11+、`uv`，已 `uv sync` 安装锁定的 `.venv`。

## 命令总览

| 命令 | 是否交互 | 用的配置段 | 用途 |
|---|---|---|---|
| `repl` | 默认交互 | `repl.*`（`repl_profile`、`repl_tool_preset`、`qa_max_steps` 等） | 人工调试、单步对话 |
| `repl --auto-first-user --exit-after-auto` | 否，跑一轮即退 | 同 `repl` | 复用 REPL 配置做一次性执行（轻量单步） |
| `run` | 否，跑完即退 | `lnr.*` / `profile_overrides`，**不读 `repl_*`** | 单任务 LNR 一次性执行 |
| `parallel` | 否，批量 | 同 `run`（子进程调 `cli run`） | 多任务并行、长时 LNR 实验 |
| `prep` | 否 | `repl.*`（data-prep agent） | 数据预处理 |
| `monitor` / `monitor-trace` | 只读监控 | — | 查看 LNR 运行状态，不启停任务 |

`repl_profile` 仅接受 `lite`（默认）和 `legacy`，不存在 `heavy`。所谓"轻量 vs 长时"对应的是**命令路径**（`repl` 轻量单步 vs `parallel` 长时多 worker LNR），而非同一命令的开关。

---

## 1. 交互式：REPL 模式

进入一个可人工输入指令的交互界面，适合调试、改 prompt、单步观察。

```bash
uv run python -m scienceflow.cli repl -m scripts/repl.yaml
```

`scripts/repl.yaml` 示例（单任务 manifest）：

```yaml
defaults:
  config: scienceflow/config/default.yaml
  workspace_base: ./workspaces/manual_repl
  qa_max_steps: 100000
  scienceflow_bash_timeout_sec: 3600
  scienceflow_bash_timeout_slow_sec: 3600

tasks:
  - exp_id: nomad2018-predict-transparent-conductors
    run_id: nomad2018-repl
    input_data_dir: ./data/mlebench_all_data/nomad2018-predict-transparent-conductors/prepared/public
    cpu_list: "0-31"
    gpu_list: "auto"
```

常用选项（`scienceflow/cli.py:517-582`）：

- `--manifest / -m`：单任务 manifest，与 `-w` 互斥。
- `--workspace / -w`：直接指定 workspace 目录（不用 manifest 时）。
- `--config / -c`：覆盖 config yaml。
- `--exp-id`：覆盖 `cfg.exp_id`，用于从 `tasks/**/<exp_id>/task.yaml` 查任务描述。
- `--input-data-dir / -d`：只读原始数据根，自动软链到 `workspace/dataset/`。
- `--plain`：关闭 Rich UI，纯文本模式。
- `--show-code N`：每步代码预览行数，默认 5；0 隐藏；-1 全量。
- `--enable-sandbox / --no-enable-sandbox`：是否限制 agent 只能读写当前 workspace（默认开）。
- `--auto-first-user / --no-auto-first-user`：启动后自动跑一轮首问再进交互。
- `--exit-after-auto / --no-exit-after-auto`：配合上一项，跑完首问即退出（非交互一次性执行）。

REPL 交互内指令：`exit` / `quit` / `q` 退出；`/compact` 压缩上下文；`/files` 查看文件状态。

### REPL 走的配置

`repl.*` 段（`scienceflow/config/defaults/repl.yaml`、`settings.py:440-481`）：

- `repl_profile: lite`（默认）/ `legacy`
- `repl_tool_preset: bash_write`（默认，bash 改文件）/ `write_edit`（legacy 的 write/edit 工具）
- `repl_max_steps` / `qa_max_steps`：单轮 LLM↔tool 交互上限
- `repl_workspace_git_enabled` / `repl_workspace_git_auto_checkpoint`：workspace 源码控制
- `repl_bash_max_output_chars` / `repl_bash_observation_summary`：bash 输出裁剪

**注意**：`repl` 每次启动都 `create_science_agent(load_existing_memory=False)`，会覆盖旧 memory，不支持续上一次 REPL session 的对话历史。

---

## 2. 非交互式（轻量单步）：repl --auto-first-user --exit-after-auto

复用 REPL 通道的 `repl_profile` / `repl_tool_preset` 等配置，但跑完一轮首问就退出，不进交互界面。

```bash
uv run python -m scienceflow.cli repl -m scripts/repl.yaml \
  --auto-first-user --exit-after-auto
```

也可在 manifest 里写死：

```yaml
defaults:
  repl_auto_first_user: true
  repl_exit_after_auto: true
  repl_profile: lite
```

适用：单任务、一轮 LLM↔tool 交互即可出结果，不需要 ESTRA / 多 worker / 资源仲裁。

---

## 3. 非交互式（长时 LNR）：parallel

批量起任务，每个任务在子进程里调 `cli run`（`parallel_runner.py:988-1030`），自带 ESTRA、Stage Gate、资源仲裁、多 worker、wall-clock 预算、resume。

```bash
uv run python -m scienceflow.cli parallel -m scripts/lnr.yaml -j 1
```

`scripts/lnr.yaml` 示例：

```yaml
max_concurrent: 1
time_limit: 3900
resume: false

lnr:
  wall_clock_budget_sec: 3600
  num_workers: 2
  omp_threads_cap: 8
  resource_control_mode: resource_smart_llm

defaults:
  config: scienceflow/config/default.yaml
  workspace_base: ./workspaces/manual_lnr
  mlebench_data_root_dir: ./data/mlebench_all_data

tasks:
  - exp_id: nomad2018-predict-transparent-conductors
    run_id: nomad2018-w2cpu8-1h-nogpu-seed2222
    input_data_dir: ./data/mlebench_all_data/nomad2018-predict-transparent-conductors/prepared/dataset_split/Deep
    cpu_list: "0-15"
    gpu_list: cpu
    lnr:
      seed: 2222
      resource_gpu_pool: []
```

选项（`scienceflow/cli.py:795-818`）：

- `--manifest / -m`：manifest yaml（必填）。
- `--max-concurrent / -j`：最大并发任务数。
- `--log-dir`：遗留外部子进程日志目录（默认日志在各自 task workspace 的 `task_logs/`）。

manifest 关键字段：

- `lnr.wall_clock_budget_sec`：总 wall-clock 预算（默认 3600s，可调到 43200 跑 12h）。
- `lnr.num_workers`：每任务的持久研究 worker 数（默认 2）。
- `lnr.resource_control_mode: resource_smart_llm`：开启 `heavy_gpu_train` 等资源仲裁。
- `lnr.estra_enabled` / `lnr.estra_trigger_stage_count`：边界重锚定。
- `resume: true`：预算级续跑（扣减已用 wall-clock 时间）。
- `phase: run`（默认）→ 子进程跑 `cli run`；`phase: prep` → 子进程跑 `cli prep`。

多任务并行示例：

```bash
uv run python -m scienceflow.cli parallel -m scripts/lnr_nomad2018_3seed_cpu.yaml -j 3
uv run python -m scienceflow.cli parallel -m scripts/lnr_two_tasks.yaml -j 2
```

### 续跑（memory 自动加载）

LNR solver 启动时自动检测 workspace 下的 memory 目录，存在就加载已有对话历史继续（`solver/lnr/solver.py:10048`）：

```python
load_existing = (self.memory_dir / "ScienceAgent").is_dir()
agent = self._make_agent(load_existing_memory=load_existing)
```

所以**用同一个 workspace 再跑一次，即自动接着上次的对话记忆继续**，无需额外选项：

```bash
# 第一次
uv run python -m scienceflow.cli parallel -m scripts/lnr.yaml -j 1
# 续跑（同 workspace）→ 自动加载 memory
uv run python -m scienceflow.cli parallel -m scripts/lnr.yaml -j 1
```

若要让预算也续上，在 manifest 设 `resume: true`（`parallel_runner.py:910`）；预算策略由 `resume_budget_policy` 控制（`remaining` / `fresh`，`parallel_runner.py:755-771`）。

---

## 4. 非交互式（单任务一次性）：run

不经过 manifest，直接调 `Orchestrator.run()` 跑 LNR，跑完即退（`scienceflow/cli.py:484-514`）：

```bash
uv run python -m scienceflow.cli run \
  -t "<任务描述或 exp_id>" \
  -w <workspace目录> \
  -c <config yaml> \
  -d <input_data_dir>
```

选项：

- `--task / -t`（必填）：任务描述。
- `--workspace / -w`：workspace 根目录。
- `--config / -c`：config yaml。
- `--input-data-dir / -d`：只读原始数据根。
- `--type`：固定 `lnr`。

`run` 同样会自动加载已有 memory（同 `parallel` 的子进程逻辑），用同一 workspace 重跑即续对话。

> 注：`scripts/lnr_kill_resume.sh` 里的 `cli run --resume --resume-step` 是过时脚本，当前 `cli run` 已无这两个 click 选项，`Orchestrator.run` 的 `resume`/`resume_step` 参数被显式忽略。续跑靠同 workspace 自动 memory 加载 + manifest 的 `resume: true`。

---

## 5. 辅助：prep / monitor

### 数据预处理

```bash
uv run python -m scienceflow.cli parallel -m scripts/prep.yaml -j 1
# 或直接
uv run python -m scienceflow.cli prep -t "<任务描述>" -w <workspace> -d <input_data_dir>
```

### 监控（只读，不启停任务）

```bash
# 跟踪某个 manifest 的多任务状态
uv run python -m scienceflow.cli monitor -m scripts/lnr.yaml --refresh 5
# 或用脚本
./scripts/monitor_lnr.sh scripts/lnr.yaml 5

# 单任务 workspace
uv run python -m scienceflow.cli monitor -l <workspace>/task_logs --refresh 5

# 导出 HTML 趋势图
uv run python -m scienceflow.cli monitor-trace -m scripts/lnr.yaml -o trace.html
```

---

## 6. 两种规模的对照

| | 轻量单步（lite 规模） | 长时多 worker（heavy 规模） |
|---|---|---|
| 入口 | `cli repl --auto-first-user --exit-after-auto` (`cli.py:571`) | `cli parallel -m <lnr manifest>` (`cli.py:795`，子进程 `cli run` `cli.py:484`) |
| 配置段 | `repl.*`（`repl_profile`, `repl_tool_preset`, `qa_max_steps`） | `lnr.*`（`wall_clock_budget_sec`, `num_workers`, `estra_*`, `resource_control_mode`） |
| Solver | 单 ScienceAgent 一轮 | LNR solver + ESTRA + Stage Gate + 资源仲裁 |
| 交互 | 跑完一轮即退 | 全程非交互，跑满预算或达标 |
| Resume | 不支持 | 支持（同 workspace 自动 memory 续跑 + `resume: true` 续预算） |
| 监控 | 无 | `cli monitor` / `monitor-trace` |

---

## 7. 自包含示例（无需外部数据）

Circle Packing 数学优化示例，无数据集依赖：

```bash
# 1. 准备任务包
uv run python tasks/opt_solver/_tools/prepare_math_opt_solver_tasks.py

# 2. 跑 LNR
uv run python -m scienceflow.cli parallel \
  -m scienceflow/config/examples/tasks_circle_packing_example.yaml -j 1
```

Agent 会在 `artifacts/best_solution.json` 迭代改进，系统侧 evaluator 按半径之和打分。

---

## 8. 配置要点速查

| 设置 | 作用 |
|---|---|
| `lnr.num_workers` | 单任务内持久研究 worker 数 |
| `task.cpu_list` / `task.gpu_list` | 任务级 CPU/GPU 资源边界；LNR 再把 CPU 切给各 worker |
| `lnr.omp_threads_cap` | 每 worker 的 CPU 线程上限 |
| `lnr.wall_clock_budget_sec` | LNR 进程总 wall-clock 预算 |
| `lnr.estra_enabled` / `estra_trigger_stage_count` | ESTRA 开关与触发阈值 |
| `lnr.resource_control_mode` | `resource_smart_llm`（默认）开启资源仲裁 |
| `resume` / `resume_budget_policy` | 续跑开关与预算策略（`remaining` / `fresh`） |
| `evaluator.backend` | `auto`（默认）/ `task_package` / `artifact_command` |
| `profile_overrides.<profile>` | 按任务类型覆盖 prompt、Evaluator、资源行为 |
| `repl_profile` | `lite`（默认）/ `legacy`，仅 `repl` 命令生效 |
| `repl_tool_preset` | `bash_write`（默认）/ `write_edit`，仅 `repl` 命令生效 |

详见 `scienceflow/config/settings.py:440-481`（REPL 段）与 `lnr.*` 相关字段。
