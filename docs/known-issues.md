# ask-bridge 上游问题清单

> **范围**：只保留必须由 ask-bridge（Go 二进制）修的问题。wfa 侧能提前拦截、标注或绕过的，已经落在 wfa 0.2.3，见文末「wfa 侧已做」，不占本清单。
> **环境**：Windows 11 zh-CN / Git Bash / ask-bridge 0.4.0 / wfa 0.2.2→0.2.3 / Chrome headful（`--window-position=-2000,-2000`）/ providers: ChatGPT + Gemini。
> **证据**：2026-11-21 单机实测，命令与时间均为真实运行结果；run 目录可复核。

## 汇总

| 编号 | 问题 | 级别 | wfa 侧现状 |
| --- | --- | --- | --- |
| U1 | Gemini 附件上传必然超时 | 阻断 | 文本自动内联，二进制提前拒绝 |
| U2 | prompt > 约 44 KiB 静默截断 | 阻断 | 40 KiB 拦截并给拆分计划 |
| U3 | ChatGPT 长产物进 Canvas，`response.md` 只有链接 | 阻断 | 检测并警告 |
| U4 | `--new-session` 复用旧会话 | 严重 | 比对 threadUrl 并警告 |
| U5 | Gemini 输出被二次转义 | 严重 | 检测并警告 |
| U6 | 双 provider 并发不稳定 | 一般 | 默认串行 |
| U7 | Chrome `exit_type` 停在 `Crashed`，弹恢复气泡 | 一般 | 外部包装器治标 |
| U8 | `chrome-devtools-mcp.log` 无轮转 | 一般 | 外部脚本截断 |
| U9 | 缺 `submissionState` 等提交证明字段 | 设计 | 靠错误文本推断 |

---

## U1 Gemini 附件上传必然超时

**现象**：给 Gemini 带任意 `--file` 附件，50–54 秒后失败：

```
Timed out waiting for Gemini to show attachment 'skein-source-bundle-191ae7c.md'   elapsed=54s
Timed out waiting for Gemini to show attachment 'skein-source-bundle-191ae7c.txt'  elapsed=50s
Timed out waiting for Gemini to show attachment 'source-bundle-e7430cb187f7.txt'   elapsed=50s
```

**复现**：

```bash
wfa ask --provider gemini --prompt "读一下附件" --file note.md --timeout 300
```

同内容内联进 prompt 就成功，说明与文件内容无关，是上传通道。

**期望**：上传控件选择器或完成判定已过期。要么修好，要么在上传阶段暴露可观察状态（开始/已选中/进度/UI 确认），失败时立刻报错，而不是干等 50 秒再抛一句 timeout。短期无法修时，元数据至少给 `attachmentState: not_started | uploading | attached | failed`。

**影响**：Gemini 这一路完全不能用附件；只能走内联，而内联又会撞 U2。

---

## U2 prompt > 约 44 KiB 静默截断

**现象**：84 KB（77 KB 源码 + 7 KB 问题）送进 Gemini，29 秒返回。回答里写：

```
证据：install/install.sh:158（附件末尾）—— `数`
证据：附件文件清单与末尾截断 —— 源码包仅完整给出了 README.md、docs/design.md、
install/install.ps1、install/install.sh（截断于第 158 行），其余 22 个文件的正文未在附件中展开。
```

那个版本的 `install.sh` 有 271 行，只送到 158 行；文件清单之后的 22 个文件正文一个都没到。**整个过程没有任何截断信号**：无警告、无 metadata 字段、退出码 0。

**复现**：

```bash
python -c "open('big.md','w').write('X'*86000)"
wfa ask --provider gemini --prompt-file big.md --timeout 600
# 看返回内容引用的文件是否止于某一行
```

**期望**：注入后回读输入框实际字节数，与原文比对；不一致就拒绝提交。元数据补：

```json
{ "promptBytesExpected": 86000, "promptBytesVerified": 44980, "promptTruncated": true }
```

**影响**：这是最危险的一类——错误结论看起来完全正常、耗时更短、显得更"高效"。

---

## U3 ChatGPT 长产物进 Canvas，`response.md` 只有链接

**现象**：prompt 明确要求「完整 diff 直接贴进回复，不要画布/附件/下载链接」。回复 440 行 / 17.9 KB，第 225 行是「下载完整 git apply 补丁」，补丁正文在 Canvas 产物里；`response.md` 只剩链接、文件名和 SHA256。`--download-images` 不管文本产物。

**复现**：要求一个 > 300 行的补丁或长文件，观察 `response.md` 是否出现 `sandbox:` 链接 + 64 位十六进制。

**期望**：抓取器提取 Canvas 面板内容并落盘，元数据补 `artifacts: [{ path, type, bytes, sha256 }]`；只拿到下载链接不应算作完整结果。

**影响**：自动化流程拿不到产物，必须人工点下载。

---

## U4 `--new-session` 复用旧会话

**现象**：给 ChatGPT 发新问题（`jobs.jsonl` 里记录的确实是新 prompt），回复的却是上一轮的答案，连「7 个文件」这种只属于上一轮的细节都对得上；`threadUrl` 与上一轮相同。

**复现**：

```bash
wfa ask --provider chatgpt --workspace same-key --new-session --prompt "问题 A"
wfa ask --provider chatgpt --workspace same-key --new-session --prompt "问题 B"
wfa status <第二个 task-id>   # 比较两次的 Conversation
```

**期望**：`newSession: true` 需要真正的强制新建语义——新建标签页或新建 thread，并校验会话 URL 与上一次不同，否则拒绝发送。返回结果里带 `threadUrl` 与本次 prompt 首行摘要，便于断言。

**影响**：拿到的答案属于旧问题，而且看起来切题，不核对细节发现不了。

---

## U5 Gemini 输出被二次转义

**现象**：即使成功返回，Markdown 也被破坏：

- `||` → `\vert{}\vert{}`
- `"$STORE"` → `"STORE"update"STORE"`
- `diff --git` 头丢失、`---`/`+++` 行不完整

**期望**：转换链路不要对 `<pre><code>` 内容做二次 LaTeX/Markdown 转义，保留原文；或在输出前做一次反转义校验，检测到 `\vert{}`、`\lbrace`、`\textbackslash` 时标记 `transformed: true`。

**影响**：`git apply` 无法执行，返回的补丁只能当问题清单读。

---

## U6 双 provider 并发不稳定

**现象**：ChatGPT 与 Gemini 同时跑会互相干扰（同机实测，`--concurrency 2` 下常出现 `failed to open tab: list_pages failed: The selected page has been closed`）。`wfa compare` 因此实际不可用。

**期望**：`--concurrency > 1` 时每个 job 用独立浏览器上下文（独立 page / 独立 profile），或明确声明该模式不支持并在 CLI 层拒绝。

**影响**：双 provider 交叉验证退化成「先后两次单 provider 审阅」。

---

## U7 Chrome `exit_type` 停在 `Crashed`，弹恢复气泡

**根因**：`ask-bridge batch` 没有 headless 参数，实际以 headful 启动 Chrome 并用 `--window-position=-2000,-2000` 把窗口挪到屏幕外；退出时强杀进程，`chrome-profile/Default/Preferences` 里的 `profile.exit_type` 停在 `Crashed`。下次启动读到就弹「恢复页面」气泡，而该气泡是独立窗口，不受离屏坐标约束，会直接出现在屏幕上。

**期望**：进程内优雅关闭（CDP `Browser.close` 后等退出），或退出前主动把 `exit_type` 写回 `Normal`；也可以直接给 Chrome 传 `--hide-crash-restore-bubble`。

**影响**：每次调用都可能弹一个窗口打断用户；外部只能靠启动前改写 `Preferences` 治标。

---

## U8 `chrome-devtools-mcp.log` 无轮转

**现象**：该日志曾增长到 166 MB（`--logFile` 没有轮转策略）。

**期望**：内置轮转（按大小或按天），或提供关闭日志的开关。

**影响**：长期占用磁盘；C 盘曾因此只剩 6.8 GB。

---

## U9 缺 `submissionState` 等提交证明字段

**现象**：wfa 判断「这次请求有没有发出去」只能靠错误文本匹配（`failed to open tab`、`prompt submission failed`、附件超时）。ask-bridge 一改文案，判定就失效。

**期望**：任务元数据补：

```json
{
  "submissionState": "not_submitted | submitted | unknown",
  "promptBytesExpected": 86000,
  "promptBytesVerified": 86000,
  "promptTruncated": false,
  "attachmentState": "not_started | uploading | attached | failed"
}
```

**影响**：这是 U2/U4 能否被可靠判定的前提；有了它，wfa 的锁判定可以从「猜文案」升级为「读状态」。

---

## 建议优先级

- **P0**：U2（静默截断产生「看起来正常」的错误结论）、U4（答非所问且难察觉）、U1（Gemini 附件完全不可用）
- **P1**：U3（长产物取不到）、U5（输出不可直接用）、U9（其余判定的地基）
- **P2**：U6、U7、U8

---

## wfa 侧已做（不在本清单）

wfa 0.2.3 起：

- 正文超 40 KiB 在发送前拦截（`PROMPT_OVERSIZE`）；`--dry-run` 给文件级 `splitPlan`；`--allow-oversize` 放行。
- Gemini 遇到文本附件时自动内联（带行号的源码包直接内联）；二进制/原生文档提前拒绝（`GEMINI_ATTACHMENT_UNSUPPORTED`）；`--allow-gemini-attachments` 强制走原生上传。
- `response.md` 出现 Canvas 存根特征或 `\vert{}` 类转义时标记 `responseHeuristics` 并在 CLI 警告，不修改正文。
- `--new-session` 完成后比对上一轮 `threadUrl`，相同则记 `sessionIsolationWarning`。
- 默认 chatgpt + gemini，多 provider 默认串行（`--concurrency 1`）。
- 可证明未提交的失败（tab 打开失败、Send 按钮未激活、附件上传超时）自动解锁 workspace。

以上都只是**检测与规避**，不是修复：U1–U5 的根因仍在 ask-bridge。
