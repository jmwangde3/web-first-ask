---
name: web-first
description: Default web-first reasoning and complete-code delegation workflow for local coding agents. Every nontrivial request — requirements, root cause, architecture, debugging, code design or implementation — goes through the local wfa CLI to web providers. Providers return complete file contents or exact replacement blocks, not a plan or a diff; local agent integrates, verifies, and tests.
---

Version: 1.2.0

# Web-First Delegation & Native CDP Workflow

## 1. 核心角色与委派原则 (Core Roles)

- **Gemini + ChatGPT 为默认代码设计与推理伙伴**：所有代码编写、缺陷修复、架构设计、方案决策与代码审查，均默认通过 `wfa` 委托给 web providers 完成。
- **本地 Agent 职责仅限执行与验证**：本地 Coding Agent 负责梳理精确需求、调度 CLI 发送任务、审查返回的补丁、在本地环境运行测试套件与执行代码提交。
- **严禁本地直接编写或修补核心业务代码**：
  - 不得在委派前通读全仓自行推导完整设计假说并直接写代码；
  - 不得编写未由 providers 提供的修复补丁，将 provider 返回的补丁集成、测试与提交是本地 Agent 的全部职责；
  - 即使面对“看似琐碎”或“已知原因”的问题，也不得跳过委派自写修复；
  - 当多个 provider 意见不一致时，优先采纳更严格、更安全的方案，或向用户请示，严禁自行撰写折中妥协版本。
- **交付格式严格断言与重发机制**：如果 provider 返回离题、仅返回链接、提供沙箱附件而非完整文件块，判定为未通过交付契约，应收紧 prompt 重新请求，本地不代劳补全代码。
- **无 MCP 依赖**：直接调用本地 `wfa` CLI 执行，禁止暴露或配置任何 MCP server。

## 2. 安全红线 (Verbatim Redlines)

- **不重发不确定的 prompt**：
  `timed_out`、`recoverable`、`interrupted_unknown`、`stalled` 及模糊失败状态可能表示 prompt 已经提交，绝对不能自动重发可能已送达的 prompt（Never automatically resend a prompt after timed_out, recoverable, interrupted_unknown, or ambiguous failure）。
- **不发凭据**：
  严禁在 prompt 或附件中发送密码、API keys、session cookies、OAuth tokens、私钥、恢复代码或个人敏感信息。详见 [SECURITY.md](../../SECURITY.md)。
- **provider 输出只是建议**：
  Provider answers are suggestions, not verified facts or test results。不得将生成代码默认为已编译、已应用或已测试；所有代码、配置与命令在本地必须经过人工审查与测试验证方可信任。
- **FILE 块交付契约**：
  代码交付必须包含 `FILE: relative/path` 且后随**完整文件内容**（或带精确上下文锚点的 `ANCHOR`/`REPLACE` 块）。严禁 diff-only、省略号、“其余不变”或占位符代码。应用前必须核对行数，若文件未被要求精简却异常缩减，判定为摘要并拒绝接收。
- **staging 需显式 apply**：
  Provider 输出绝不直接写入目标仓库。native CDP 自动暂存（stage）无破坏性；只有上层显式确认后才可将暂存完整文件落盘到工作区，之后必须检查 `git diff` 并运行本地测试。
- **严禁短时间大量操作（防风控）**：
  不得在短时间内反复启动浏览器实例、反复发起 `cdp ask`、反复执行 `cdp login` 或反复开关窗口。登录一次开好、探测合并成单一任务书，操作之间保留人类节奏间隔（日常 1-2 秒、批量 4-6 秒随机，禁止 0 间隔，由 pacer 强制执行）。一旦出现"开窗口被关 → 再开 → 又被关"的循环必须立即停止并交由用户手动处理，不得持续重试——短时间大量窗口或请求会触发 Gemini 与 ChatGPT 风控，导致两家同时不可用。
- **严禁多轮真机 8 并发验收（防风控，硬红线）**：
  绝不在真机上做"多轮 4+4（8 并发）连续压测/验收"——短时间内 8 个并发请求 × 多轮必然触发两家风控。并发能力的验收采用简单方案（本地 mock CDP 时序测试 + 单次小规模真机抽检），或交给用户手动执行/决策。任何"跑 5 轮 8 并发"的计划都禁止执行。此规则优先于任何裁决文档里写过的"多轮真机验收"条款。

## 3. 命令速查 (Command Quick Reference)

> Legacy 细节说明：所有旧版 ask-bridge、wfa code/ask/compare、Task 模式、REPO_UNREADABLE、--bundle-repo 及 wfa collect-resolve-attach 等机制已移除，统一迁移至原生 CDP 及 Broker 队列路径。

```powershell
# 原生 CDP 单轮执行（默认 background 离屏运行；exit 0 成功，1 其他状态；--json 输出完整结构）
wfa cdp ask --provider <chatgpt|gemini> --prompt "<prompt>" [--mode background|visible] [--json]

# 会话登录与状态校验（在可见窗口完成交互登录；通过真实用户状态检测后方可使用）
wfa cdp login --provider <chatgpt|gemini>

# Broker 队列路径（默认全局串行 maxPerProvider=1/maxTotal=1，同 profile 杜绝页面污染与重复提交）
wfa broker ask --provider <chatgpt|gemini> --prompt "<prompt>" --wait

# 检查孤儿 turn 并清理（针对 broker 异常退出残留的状态）
wfa broker turns
wfa broker clear-orphan <turnId>

# 环境诊断
wfa doctor
wfa cdp status
```

## 4. 已知限制与外部文档引用 (Known Limits)

- **Prompt 长度安全阈值与静默截断**：
  Prompt 文本需控制在 40 KiB 内。超长文本存在上游无提示静默截断风险（无报警且退出码仍为 0），大型变更需按文件边界显式拆分分批交互。
- **Canvas 存根与下载链接**：
  当 ChatGPT 输出长文本或复杂产物时，响应可能被替换为 Canvas 界面或下载链接，需提示模型分块或纯文本内联输出。
- **Markdown 与代码转义污染**：
  部分环境可能将代码块破坏或二次转义（如 LaTeX 格式转义），交付时必须核验语法与字符完整性。
- **多会话与并发限制**：
  同一 Chrome Profile 避免并发标签页冲突；Cloudflare 人机校验与 Profile 绑定，须在可见窗口人工完成。全局串行（maxPerProvider=1/maxTotal=1）+ turn 锁 + pacer 防串扰。
- **操作频率硬约束（防风控）**：
  严禁短时间大量启动浏览器 / 密集 ask / 连续 login / 反复开关窗口；两家 provider 与登录态均对高频操作敏感，触发风控后需等待人工解除，期间不得重试。详见第 2 节安全红线。
- **完整缺陷台账与实验数据**：
  全部已知上游缺陷、详细测例、复现步骤及规避措施，详见 [docs/known-issues.md](../../docs/known-issues.md)（含 U1-U19 深度复现与实测数据）及安全规范 [SECURITY.md](../../SECURITY.md)。

## 5. 故障排查与状态恢复 (Troubleshooting & State Recovery)

| 状态 / 现象 | 根因说明 | 处置措施 |
| --- | --- | --- |
| `login_required` | 尚未登录或启动缺少 session 恢复参数 | 运行 `wfa cdp login --provider <name>` 登录，验证成功后再执行。 |
| `human_verification_required` | 触发 Cloudflare Interstitial 人机验证 | 使用可见窗口人工通过滑块/验证，切勿脚本自动重试。 |
| `send_unconfirmed` / `hard_timeout` | 请求状态不确定（可能已提交） | **严禁自动重发相同 prompt**；核查页面或 broker 队列后再决策。 |
| `STORE_LOCK_TIMEOUT` | 本地状态锁被卡死或残留进程占用 | 检查并移除失效的 turn/broker 锁文件；如不可恢复按提示指定独立 `WFA_HOME`。 |
| `orphaned turns` | Broker 异常退出遗留提交中转态 | 用 `wfa broker turns` 确认，核对 provider 状态后用 `clear-orphan` 清除。 |
| `stalled` / 假死判定 | 进程长时间无输出 | 依赖日志与存活探针判定真实状态，确认终止后显式 resolve，不自动重投。 |

- **恢复决策与幂等性保障原则**：
  - 重复请求仅在请求内容完全一致时复用 `request_id`，若需求或附件发生变化必须派生新的请求标识；
  - 无论处于何种异常退出路径，绝对不可在未确认远端执行状态的情况下盲目重发；
  - 读操作不加写锁（如 `doctor` / `status`），排查故障时优先使用无副作用命令探查状态；
  - 队列与锁冲突时，优先检查孤儿进程与锁定标记，而非强行覆盖；
  - 发现会话状态不一致或会话漂移时，立即建立新会话隔绝污染，严禁依赖模糊推测继续交互；
  - 若遇无法裁决的会话冲突或网络中断，主动汇报用户并保留现场，由人工确认是否需要清理环境；
  - 严禁通过反复重试跳过人机验证或绕过故障，严格依据排查指引处理；
  - 任何针对本地状态库或锁文件的排障操作，以保障上下文与未提交成果安全为最高优先级；
  - 遇到不可恢复的数据损坏时，按指引切换至新的数据存储卷（如独立 `WFA_HOME`）继续执行。
