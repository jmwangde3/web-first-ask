# wfa 已知问题（2026-11-21 实测）

> 本文只记现象、证据与影响，不写修法细节。目的是让接手的人能复现、能排序、能判断优先级。
> 环境：Windows 11 zh-CN / Git Bash / wfa 0.2.1（`web-first-ask`）/ ask-bridge headful Chrome / providers: ChatGPT + Gemini。
> 用法场景：把一个 77 KB 的源码包交给两个 provider 做离线审阅；以及一个 37 KB 的架构提问。

## 总览

| 编号 | 问题 | 级别 | 是否已用外部手段绕过 |
|---|---|---|---|
| A1 | Gemini 附件通道不可用 | 阻断 | 是（改内联） |
| A2 | 大 prompt 静默截断，provider 基于半份材料作答 | 阻断 | 是（手工切包） |
| A3 | ChatGPT 长产物默认进画布，`response.md` 取不到正文 | 阻断 | 否（人工下载） |
| A4 | 失败的 job 锁住 workspace，必须手工 `resolve` | 阻断 | 是（每次手工解锁） |
| B1 | `--new-session` 未隔离会话，答的是上一轮的问题 | 严重 | 否（只能靠改名规避） |
| B2 | Gemini 输出被转义污染，diff 无法 apply | 严重 | 否（只当清单用） |
| B3 | 没有分片概念 | 一般 | 是（手工切） |
| B4 | 两个 provider 不能并发，`compare` 不可用 | 一般 | 是（串行跑两次） |
| B5 | 后台运行时进度被吞 | 一般 | 否 |
| B6 | `--dry-run` 只统计附件字节 | 一般 | 否 |
| C1 | ask-bridge 留下 Chrome「未正确关闭」状态 | 一般 | 是（外部包装器） |
| C2 | `chrome-devtools-mcp.log` 无轮转 | 一般 | 是（外部脚本截断） |

---

## A. 阻断级

### A1 Gemini 附件通道不可用

**现象**：带 `--file` 请求 Gemini，50–54 秒后失败，状态 `failed`。

```
Timed out waiting for Gemini to show attachment 'skein-source-bundle-191ae7c.md'   elapsed=54s
Timed out waiting for Gemini to show attachment 'skein-source-bundle-191ae7c.txt'  elapsed=50s
Timed out waiting for Gemini to show attachment 'source-bundle-e7430cb187f7.txt'   elapsed=50s
```

**复现**：任意 `.md` 或 `.txt` 附件都会失败；改扩展名、改文件名都无效。同一个文件内联进 prompt 就能成功，说明不是内容问题，是上传通道问题。

**影响**：Gemini 这一路完全不能用附件，只能用内联正文——而内联又会撞上 A2。

**期望**：要么修上传，要么在检测到该 provider 不支持附件时立刻明确报错并给出"改写为内联"的下一步，而不是干等 50 秒再抛一句 timeout。

### A2 大 prompt 静默截断

**现象**：84 KB 的 prompt（77 KB 源码 + 7 KB 问题）送进 Gemini，29 秒就返回。它的回答里有这么两句：

```
证据：install/install.sh:158（附件末尾）—— `数`
证据：附件文件清单与末尾截断 —— 源码包仅完整给出了 README.md、docs/design.md、
install/install.ps1、install/install.sh（截断于第 158 行），其余 22 个文件的正文未在附件中展开。
```

实际上那个版本的 `install.sh` 有 271 行，只送到 158 行；文件清单之后本该跟着 22 个文件的正文，它一个都没看到。也就是说 provider 只收到约一半内容，然后**基于半份材料下了结论**（断言脚本被截断、目录结构缺失），这些结论全是错的。

**关键点：整个过程没有任何截断信号。** 没有警告、没有 metadata 字段、返回码也是成功。只能从"它引用了哪几个文件"反推。

**影响**：这是最危险的一类——错误结论看起来完全正常，且耗时更短、显得更"高效"。

**期望**：发送前算总量（正文 + 附件），超过阈值时要么拒绝、要么自动分片、要么至少在 metadata 里记下 `bytesSent` / `bytesTruncated`。

### A3 ChatGPT 长产物默认进画布

**现象**：prompt 里明确要求"完整 diff 直接贴在聊天回复的代码块里，不要用画布/附件/下载链接"。回复共 440 行 / 17.9 KB，第 225 行是：

```
下载完整 git apply 补丁
```

补丁正文在画布产物里，`response.md` 只有链接、文件名和 SHA256。`--download-images` 只管图片，管不到这种文本产物。

**影响**：自动化流程拿不到补丁，必须人工点下载。用户最终是从浏览器里手工存到桌面的。

**期望**：能配置"强制内联"或提供产物落盘目录（把画布内容按文件名导出到 run 目录）。

### A4 失败的 job 锁住整个 workspace

**现象**：一次 `failed` 之后，同 provider、同 workspace 的后续请求直接被拒，必须先：

```bash
wfa resolve <run-id> --provider <provider> --confirm
```

**影响**：任何自动重试都会卡住。一次上传超时（A1）能连锁堵住后面所有请求。

**期望**：`failed` 状态不应阻止新会话；或提供 `--allow-stale` / 超时自动释放。

---

## B. 正确性与可用性

### B1 `--new-session` 未隔离会话

**现象**：给 ChatGPT 发"建库归属与作用域模型"九个文件的问题（`jobs.jsonl` 里记录的 prompt 是新问题），它回的是上一轮"B 能否随时接管 A 的任务"的答案——连"7 个文件"这种只属于上一轮的细节都对得上。`threadUrl` 与上一轮指向同一会话。

**影响**：拿到的答案是旧问题的，浪费一整轮；而且答案本身看起来切题（都是 Skein 相关），不核对细节发现不了。

**现状规避**：换 workspace 名（等于换一个浏览器 page/会话）。但这是运气，不是保证。

**期望**：`--new-session` 应强制新建 thread；返回结果里带 `threadUrl` 与本次 prompt 的首行摘要，便于断言。

### B2 Gemini 输出被转义污染

**现象**：即使成功返回，diff 也被破坏：

- `||` → `\vert{}\vert{}`
- `"$STORE"` → `"STORE"update"STORE"`
- `diff --git` 头丢失、`---`/`+++` 行不完整

**影响**：`git apply` 无法执行，只能当"问题清单"读，改动全部人工重写。

**现状规避**：不要求它给 diff，改要求"文件 + 替换前原文 + 替换后原文"。

### B3 没有分片概念

**现象**：要么整包发（撞 A2），要么自己切。手工切出来的每一片是**独立会话**，跨文件的契约类问题（例如"四个技能共享同一段路径解析"）天然审不全。

**影响**：大仓库审阅只能靠人拼结论。

### B4 两个 provider 不能并发

**现象**：ChatGPT 与 Gemini 同时跑会互相干扰（本机已确认），`wfa compare` 实际用不了。只能串行跑两次，而且两次看到的材料可能不一致（一个用附件、一个用内联）。

**影响**：所谓"双 provider 交叉验证"退化成"先后两次单 provider 审阅"。

### B5 后台运行时进度被吞

**现象**：`wfa ask ... | tail -30` 在后台跑时，管道要等进程结束才输出，中途完全看不到进度，只能靠外层轮询任务状态。

**期望**：`--progress-file` 或结构化进度输出。

### B6 `--dry-run` 只统计附件字节

**现象**：`--dry-run` 输出的 `estimatedTokens` 只算 `--file` 的大小，`--prompt-file` 的正文体积与截断风险不提示（A2 正是从正文来的）。

**期望**：分别给出正文、附件、合计三项字节与预估 token，并对超阈值给警告。

---

## C. ask-bridge 侧（已有外部规避，根因未修）

### C1 Chrome「未正确关闭」恢复气泡

**根因**：`ask-bridge batch` 没有 headless 参数，实际以 headful 方式启动 Chrome（`--window-position=-2000,-2000` 把窗口挪到屏幕外），退出时强杀。于是 `chrome-profile/Default/Preferences` 里的 `profile.exit_type` 停在 `Crashed`。下次 Chrome 启动读到它就弹"恢复页面"气泡，而且这个气泡是独立窗口，不受离屏坐标约束，会直接出现在屏幕上。

**现状规避**：外部包装器在每次调用前把 `exit_type` 改回 `Normal`。属于治标。

**期望**：进程内优雅关闭，或退出前主动写回 `exit_type`。

### C2 `chrome-devtools-mcp.log` 无轮转

**现象**：日志曾增长到 166 MB。

**现状规避**：外部脚本在超过 64 MB 时截到尾部 4 MB。

**期望**：内置轮转。

---

## D. 复现记录（脱敏）

| 时间 | 请求 | provider | 结果 |
|---|---|---|---|
| 14:13 | 77 KB 源码包（`--file`，`.md`） | ChatGPT | 成功，567s（9.5 分钟），19 条问题；补丁进画布（A3） |
| 14:24 | 同一文件改 `.txt`（`--file`） | Gemini | 54s 失败（A1） |
| 14:24 | 再试 `.txt`，第二次 | Gemini | 50s 失败（A1） |
| 14:25 | 84 KB 内联单文件 | Gemini | 29s "成功"，基于半份源码，结论错误（A2） |
| 14:26 | 拆成 27 KB + 24 KB 两包，内联 | Gemini | 两包都成功，内容可用；diff 被转义（B2） |
| 14:44 | 32 KB 内联（接管机制） | ChatGPT | 成功，264s，结论与 Gemini 一致 |
| 14:44 | 同上 | Gemini | 成功，22s |
| 15:19 | 37 KB 内联（建库归属） | ChatGPT | 336s 后返回，但答的是 14:44 的问题（B1） |
| 15:19 | 同上 | Gemini | 成功，34s，内容切题 |

---

## E. 现在实际怎么用（规避手册，不是修复）

1. **附件别用**，尤其 Gemini。所有源码内联进 prompt。
2. **单包 ≤ 44 KB**，超了手工切，切口选在文件边界。
3. **每个 provider 用独立 workspace 名**，并且每次都带 `--new-session`；仍要核对答案是否对应本次问题。
4. **失败先解锁**：`wfa resolve <run-id> --provider <p> --confirm`。
5. **ChatGPT 的补丁让用户手工下载**，不要指望 `response.md` 里有正文。
6. **不要求 Gemini 出 diff**，改要"文件 + 替换前原文 + 替换后原文"。

---

## F. 建议优先级

- **P0**：A2（静默截断会产生"看起来正常"的错误结论）、A4（一次失败连锁堵死后续请求）、A1（Gemini 附件完全不可用）
- **P1**：B1（答非所问且难察觉）、A3（长产物取不到）、B2（输出不可用）
- **P2**：B3、B4、B5、B6、C1、C2
