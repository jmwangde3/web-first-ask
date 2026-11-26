# web-first-ask (wfa) 用户需求规格书（整理定稿版）

> 本文为 2026-11-26 整理定稿版，作为当前需求基线，供 provider 直接读取；实现状态与缺陷跟踪见 [`backlog.md`](backlog.md)，历史 provider 限制见 [`known-issues.md`](known-issues.md)。

定位：单机使用的 Node.js CLI（原生 CDP 驱动 Chrome，零运行时依赖，不再依赖 ask-bridge）+ 极简 Skill。

整理日期：2026-11-26

## 一、核心目标与架构定位（原 #1、#2、#3、#5、#11、#15）

- 脱离 ask-bridge：全部核心能力由 wfa 原生 CDP 引擎与本地 broker 完成。
- 重 CLI、轻 Skill：逻辑与状态控制全部内置在 wfa CLI；`skills/web-first/SKILL.md` 保持极简，仅用于引导本地 Agent（Codex、Workbuddy 等），最大限度降低上下文与 token 消耗。
- 外接大脑分工：
  - 让本地 Agent 通过 wfa 调用 Gemini（新会话默认 Task 模式）、ChatGPT 网页版（沿用网页端持久保存的高思考强度）、Claude 网页版完成规划、审查、排错与实现；
  - 凡是网页端 provider 能负责的工作全部委派，本地 Agent 仅在需要访问本地环境或执行实际文件/命令操作时介入；
  - 用户显式点名 wfa 时，本地 Agent 严禁自行思考或替代回答（除非用户另有说明）。

## 二、多模型协作与并发调度（原 #4、#6、#7、#10、#27）

- 默认双发：省略 `--provider` / `--providers` 时，默认同时向 ChatGPT + Gemini 提问，各自输出独立产物，单 provider 失败可独立重试。
- 高并发互不干扰：至少支持 4 个 Gemini + 4 个 ChatGPT = 8 并发同时运行且互不串台（`DEFAULT_MAX_PER_PROVIDER = 4`、`DEFAULT_MAX_TOTAL = 8`）。
- 同 provider 发新会话硬间隔：同一 provider 并发建新会话强制 3–5s 随机间隔（`stagger.js`），避免同一瞬间并发点击触发风控。
- 代码仓库读取与回退：代码类任务优先让 provider 直接读 GitHub 仓库；若明确返回终态 `REPO_UNREADABLE`，本地再打包代码作为附件回退发送（`--fallback-bundle`），绝不自动重发状态不明的请求。
- 交互问答边界：provider 遇到不了解本地情况的问题时，先由本地 Agent 代答；涉及无法确定的用户决策必须询问用户，不得擅自猜测。

## 三、浏览器控制、反风控与隐私（原 #13、#14、#19、#21、#23、#24、#25）

- 原生 CDP 驱动：使用真实 Chrome + CDP（不使用 Playwright 以规避 ChatGPT 风控）。
- 双模式与前台无干扰：支持 `background` / `headless`（不抢前台焦点、不干扰桌面工作）与 `visible`（便于调试或人工介入）。
- 单 Chrome + 单 Profile + 多标签：所有 provider 共用同一个 Chrome 实例与同一个专用 profile，不同会话开独立标签页；由 broker 托管常驻，避免频繁开关 Chrome，需人工介入时保留窗口。
- 指纹与时区：开启 `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` 防 WebRTC 泄漏；`Emulation.setTimezoneOverride` 固定为 `Asia/Tokyo`；不传 `--restore-last-session`（防止重启批量恢复历史标签触发 Google `/sorry`）。
- 拟人化节流：日常动作间隔 1–2s 随机，批量操作间隔 4–6s 随机，禁止 0 间隔批量操作。

## 四、输入、附件与下载（原 #8、#12、#20）

- 多形态输入：支持 `--prompt`、`--prompt-file`、stdin 以及可重复 `--file`（文本、代码、图片、文档、压缩包、目录/glob）。
- 全格式附件上传与芯片核验：支持上传 ChatGPT / Gemini 网页端支持的各类格式（含 `.zip`，Gemini 支持解压 `.zip`）；上传后必须校验可见预览芯片与文件名，失败则 fail-closed 不提交。
- 代码包下载：支持 `--download-dir`，自动触发页面内下载链接/按钮并通过 CDP 捕获落盘，附带文件体积与 SHA-256 校验。

## 五、会话复用与清理策略（原 #9、#22、#29）

- 同会话续聊：通过本地 key `--conversation-id` 复用同一远端对话，减少上下文重复；达到 40 轮输出 `CONVERSATION_40_TURNS` 预警。

这部分仅供参考，可以自己另行设计。

- 自动清理规则（#22）：
  - 未传 `--conversation-id`（一次性新会话）：`completed` 后默认自动删除（传 `--no-cleanup` 可保留）；非 `completed` 状态一律保留。
  - 传了 `--conversation-id`（命名续聊会话）：默认保留；仅在显式传 `--cleanup`、40 轮退役换新或手动执行 `wfa cdp cleanup` 时清理。
- 手动批量清理（#29，`wfa cdp cleanup`）：仅清理 `createdByWfa === true` 的会话，绝不触碰历史既有会话：
  - `--keep-unfinished`：清理 finished（`completed` 或提交前失败 `failed && sendCommittedAt == null`），保留 unfinished（`queued`/`running`/`stalled`/`needs_human`/`takeover`/`needs_user` 以及 `failed && sendCommittedAt != null`）；可选 `--keep-named` 额外保留命名续聊会话。
  - `--all`：清理全部非活跃的 wfa 会话（默认跳过 `queued`/`running`，传 `--force` 才连活跃任务一起清）。

## 六、工程与安全边界（原 #16、#17、#18、#26、#28）

- 单机信任模型：本机默认单操作者、无远程暴露，不添加冗余安全拦截或 SKILL/SECURITY 敏感材料发送限制；保持代码简洁可读、零运行时依赖。
- 以真机实测为准：不过度堆砌低价值测试，验收与测试注意操作间隔避免触发风控；不盲信旧版 ask-bridge 历史缺陷结论。
- 冲突透明：技术实现与需求存在冲突时先向用户汇报并由用户拍板，不私自违背需求改设计。
