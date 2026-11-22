# ask-bridge 上游问题清单

> **范围**：只保留必须由 ask-bridge（Rust 二进制）修的问题。wfa 侧能提前拦截、标注或绕过的，已落实的规避方案见文末「wfa 侧已做」，不占本清单。
> **环境**：Windows 11 24H2 zh-CN / Git Bash / ask-bridge 0.4.0（`7d4731f`）/ wfa 0.2.2→0.2.9 / Chrome stable / providers: ChatGPT + Gemini。
> **证据**：2026-11-21 与 2026-11-22 两次单机实测，命令与耗时均为真实运行结果。U1、U7 已于 11-22 用对照实验与源码复核修正（见各条）。

## 汇总

| 编号 | 问题 | 级别 | wfa 侧现状 |
| --- | --- | --- | --- |
| U1 | 附件校验按完整文件名匹配页面文本，普通文件名被判成未附加 | 阻断 | 文本内联；归档名压到 17 字符后原生上传 |
| U2 | prompt > 约 44 KiB 静默截断 | 阻断 | 40 KiB 拦截并给拆分计划 |
| U3 | ChatGPT 长产物进 Canvas，`response.md` 只有链接 | 阻断 | 检测并警告 |
| U4 | `--new-session` 复用旧会话 | 严重 | 比对 threadUrl 并警告 |
| U5 | Gemini 输出被二次转义 | 严重 | 检测并在 stage/apply 阻断 |
| U6 | 双 provider 并发不稳定 | 一般 | 默认串行 |
| U7 | Chrome `exit_type` 停在 `Crashed`，弹恢复气泡 | 已修（0.4.0） | 启动前兜底保留，通常是空操作 |
| U8 | `chrome-devtools-mcp.log` 无轮转 | 一般 | wfa 启动前按 64 MiB/4 MiB 门槛轮转 |
| U9 | 缺 `submissionState` 等提交证明字段 | 设计 | 靠错误文本推断 |
| U10 | `--concurrency 1` 串行批次也关掉上一个 job 的标签页 | 阻断 | wfa 自行拆为多个独立单 job 批次（含 detach） |
| U11 | 僵尸 `running` 任务让 `list`/`status`/`resolve` 全部锁超时 | 阻断 | 0.2.8：读路径不再取写锁；`--no-refresh` 真正生效；锁等待打印持有者 |
| U12 | `.store.lock` 持有者已死但无法删除或改名 | 阻断 | 0.2.8：`wfa unlock` 接管（rename 优先 + 代次复验）；失败时报 `STORE_LOCK_UNRECLAIMABLE` 并给出路 |
| U13 | 自动把工作区 git remote 注入 `repoReference` | 严重 | 0.2.8：发送前打印被注入的 `url@commit`；默认仍注入，`--no-repo` 关闭 |
| U14 | 写 `metadata.json` 报 `os error 5`，任务被判 failed | 严重 | 0.2.8：`response.md` 存在时记 `completed` + `degradedReason`，不再丢答案 |
| U15 | `mkdir` 数据家目录报 `EPERM` | 严重 | 0.2.8：目录已存在即视为成功，真权限问题留到 `open` |
| U16 | 长生成被判 `stalled` 并杀进程：ask-bridge 生成期间不产进度行、不更新 metadata | 阻断 | 0.2.9：浏览器日志仍在写就不杀；默认阈值 300 → 900 s |
| U17 | 批次运行期 CLI 全程静默，无法区分「在等 provider」与「进程已死」 | 严重 | 0.2.9：每 60 s 打一行 `[wfa] still waiting` |
| U18 | 附件打不开时 provider 仍以 `completed` 收敛，产出为零 | 严重 | 0.2.9：识别「无法解压/读取附件」并警告 |
| U19 | `--detach` worker 被调用方宿主清理，任务落 `needs_recovery` 并锁住工作区 | 严重 | 0.2.9：空 `batch.*.log` 判 `failed_before_start`（从未提交，可直接重跑）并说明宿主限制 |

---

## U1 附件校验按完整文件名匹配页面文本，普通文件名被判成未附加

> **2026-11-22 更正**：11-21 的结论「Gemini 文档附件不可用」是错的。同一份文件、同一段内容，只改文件名：stem ≤ 20 字符全部成功，21 字符连续两次失败。归档「能用」也不是因为 zip 特殊，只是因为它叫 `bundle.zip`。当时的误判记录留在本条末尾，不再作为结论。

**现象**：单 job、单附件、Gemini。同一份 55,699 B 的 `.md`（600 个小节），同一句 prompt，唯一变量是文件名：

| 文件名 | stem 长度 | 结果 |
| --- | --- | --- |
| `notes.md` | 8 | 15 秒成功，答 `600` |
| `bundle-notes-191ae.md` | 18 | 14 秒成功 |
| `bundle-notes-191ae7.md` | 19 | 16 秒成功 |
| `source-bundle-191ae7.md` | 20 | 13 秒成功 |
| `source-bundle-191ae7c.md` | 21 | **52 秒失败**，重跑 **49 秒再失败** |
| `aaaaaaaaaaaaaaaaaaaaaaaaa.md` | 25 | **失败**（排除了「名字里带 bundle/hash 才出问题」） |
| `bundle.zip` | 10 | 17 秒成功，答 `100` |
| `repro-repo-2026-11-22_02-30-11-123-ab12.zip` | 38 | **49 秒失败** |

两次失败信息一致：

```
[batch] job <id>: failed (Timed out waiting for Gemini to show attachment 'source-bundle-191ae7c.md')
```

`metadata.json` 为 `{"state":"failed","elapsedSeconds":49,"threadUrl":"https://gemini.google.com/app"}`：`threadUrl` 停在应用根路径，说明**从未提交**，不是 provider 拒收。

**归档同样受影响**，最后两行是同一份 135 KB、100 条目的 zip，只是换了名字。11-21 那次「归档 15 秒送达」用的是手工命名的 `bundle.zip`，所以看起来像「归档免疫」——实际是短名免疫。

**根因**：`wait_for_attachment_indicator`（`src/main.rs:6934-6989`）用「完整文件名或主干是 `document.body.innerText` 的子串」判定已附加：

```js
const text = document.body.innerText || '';
return text.includes(fileName) || text.includes(fileStem);
```

Gemini 附件 chip 的标签到 20 字符左右就截断，完整 stem 永远不出现。随后 30 × 500 ms 轮询耗尽，再走 file chooser 兜底又等 15 秒，`run_job` 记 `failed`。

合成上传路径本身只证明「脚本跑过」——`__upload_images_status = 'success:file-input'` 在 dispatch 完 `change` 事件后立刻写入（`src/main.rs:7274-7280`）——所以这个子串检查是唯一真实确认，也就成了唯一误伤点。

**复现**：同内容、只改文件名。

```bash
cp note.md bundle-notes-191ae.md    # stem 18 字符 → 成功
cp note.md source-bundle-191ae7c.md # stem 21 字符 → 50 秒后失败

wfa ask --provider gemini --prompt "读一下附件" --file source-bundle-191ae7c.md --timeout 300
```

**期望**：
- 不要求完整文件名：前缀匹配前 12–16 字符，或统计 chip 数量前后差值，或等 provider 自己的「上传完成」状态
- 「无法验证」不等于「失败」；未提交时应记 `recoverable` / `unknown`，而不是 `failed`
- 用 `DOM.setFileInputFiles` 传真实路径，避免合成 `DataTransfer`
- 元数据补 `attachmentState: not_started | uploading | attached | failed`

**影响**：一个本来能答的 job 白等 50 秒后被丢弃，错误文案指向 provider。wfa 的对策是把文本内联进 prompt，而内联又会撞 U2 的 44 KiB 上限——这条缺陷的实际代价是「大文本只能二选一：截断或丢弃」。

wfa 自己生成的归档原本叫 `<slug>-<时间戳>-<hex>.zip`（约 50 字符），同样踩中，等于把 `--bundle-repo=zip` 一起废掉。0.2.9 起归档名压到 17 字符（`<slug8>-<hex8>.zip`），落在实测通过区间内。

**误判记录（2026-11-21）**：当时用 31 字符和 32 字符的文件名发包，50–54 秒失败，于是判成「需要解析的文档不可用、归档不受影响」。而用来证明「归档没问题」的那个 zip，是手工命名为 `bundle.zip` 直接调 ask-bridge 的——短名掩盖了同一缺陷。真正的变量是文件名长度，既不是 MIME，也不是解析器。

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

**影响**：`git apply` 无法执行，返回的补丁只能当问题清单读；wfa 现已在 stage/apply 阻断已识别的污染序列。

---

## U6 双 provider 并发不稳定

**现象**：ChatGPT 与 Gemini 同时跑会互相干扰（同机实测，`--concurrency 2` 下常出现 `failed to open tab: list_pages failed: The selected page has been closed`）。`wfa compare` 因此实际不可用。

**期望**：`--concurrency > 1` 时每个 job 用独立浏览器上下文（独立 page / 独立 profile），或明确声明该模式不支持并在 CLI 层拒绝。

**影响**：双 provider 交叉验证退化成「先后两次单 provider 审阅」。

---

## U7 Chrome `exit_type` 停在 `Crashed`，弹恢复气泡（0.4.0 已修）

**现象（历史）**：`batch` 退出时 Chrome 被强杀，`chrome-profile/Default/Preferences` 里的 `profile.exit_type` 停在 `Crashed`。下次启动读到就弹「恢复页面」气泡，而该气泡是独立窗口，不受离屏坐标约束，会直接出现在屏幕上。

**0.4.0 的状态**：根因已修，两处。

- **退出走 CDP**：`cdp_browser_close()` 用一条裸 WebSocket 发 `Browser.close`，再等调试端口释放最多 5 秒才考虑强杀（`src/main.rs:2053-2137`）。让 Chrome 自己 flush profile，`exit_type` 落回 `Normal`。
- **`--headless` 是全局参数，默认 `true`**，`batch` 也遵守。Windows 上的「headless」实现为 `--ask-bridge-background --window-position=-2000,-2000`（`src/main.rs:2435-2440`）：仍是真实窗口，只是移到屏幕外——所以 11-21 记的「batch 没有 headless 参数」也是错的。

**残留**：`batch` 结束时不关浏览器（Chrome 长期驻留供下次复用），所以「进程被外部强杀」这条路径仍可能把 profile 留在 `Crashed`。wfa 因此保留启动前兜底：只在 `profile.exit_type` 恰好为 `Crashed` 时原子改写成 `Normal`（`src/ask-bridge.js:36-50`），对 0.4.0 通常是空操作；`doctor` 会报告发现了几处。

**影响**：不再需要独立包装脚本，也不再需要 `--hide-crash-restore-bubble`。本条从「待上游修」转为「已修，保留兜底」。

---

## U8 `chrome-devtools-mcp.log` 无轮转

**现象**：该日志曾增长到 166 MB（`--logFile` 没有轮转策略）。

**期望**：内置轮转（按大小或按天），或提供关闭日志的开关。

**影响**：长期占用磁盘；C 盘曾因此只剩 6.8 GB。wfa 现于启动前检查该日志，超过 64 MiB 时保留末尾 4 MiB。

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

## U10 `--concurrency 1` 串行批次也关掉上一个 job 的标签页

**现象**：串行批次里第一个 job 完成后，ask-bridge 把它的标签页关了；第二个 job 在**提交之前**就失败：

```
[batch] job wfa-chatgpt-699d3563: completed in 16s
[batch] job wfa-gemini-699d3563: failed (failed to open tab: list_pages failed: The selected page has been closed. Call list_pages to see open pages.)
```

**复现**：任意两 provider 串行批次。两种顺序（`chatgpt,gemini` 与 `gemini,chatgpt`）都复现，**总是第二个 job 挂**，与 provider 无关。2026-11-22 用同 provider 两个 job 再复现一次，第二个 job 的 `metadata.json` 为 `{"state":"failed","elapsedSeconds":0,"pageId":null}`——零耗时、无 page，一个字节都没提交。

**根因**：`run_job` 在除 `Recoverable` 以外的所有终态关掉该 job 的标签页（`src/batch.rs:659-670`），而它关的正是 MCP 会话的**当前选中页**；下一个 job 的第一件事是 `list_pages_snapshot`（`src/batch.rs:727-728`），此时 `list_pages` 因选中页已不存在而失败，错误再被 `src/batch.rs:774` 包成 `failed to open tab: ...`，指向了错误的操作。

**期望**：串行批次内可以复用同一个页面直到整批结束，或下一个 job 新建页面而不是拿着已关闭的 page id 去 `list_pages`；至少要在 `close_page` 之后重选一个存活页面。

**影响**：原本串行是本机唯一可靠的模式（见 U6），因此这个缺陷让默认双 provider 的第二个任务必然先失败一次。wfa 现由自身对每个 provider 启动独立单 job 批次；这规避了 U10，但有多一次独立进程启动成本。ask-bridge 对批次内部 tab 的管理仍需上游修复。

---

## U11 僵尸 `running` 任务让全部命令锁超时

**现象**：`tasks.json` 里存在状态为 `running` 但进程早已退出的任务时，**所有**命令（包括只读的 `wfa list`、`wfa status <id>`、`wfa resolve`）都返回：

```
wfa: Timed out waiting for the local task-store lock. Do not start a duplicate request; retry the status command.
```

**证据**：本次会话中 `tasks.json`（107 个任务）里有两条 `running`，`createdAt` 分别是 2026-11-20T16:10:50Z 和 2026-11-21T17:17:00Z，对应的 `parentPid` / `childPid` 均已不存在。只要它们在，任何命令都进不去。

**复现**：让任一任务在 `running` 状态下强杀进程（关闭终端、超时被杀、机器休眠），随后执行 `wfa list`。

**影响**：`wfa resolve` 本身也需要锁，所以**无法用官方命令自救**。唯一出路是手工编辑 `tasks.json` 把 `state` 改成终态，这要求用户知道文件位置和结构。对非程序员等于 wfa 彻底报废。

**期望**：
- 启动时用 `pidAlive()` 校验所有 `running` 任务的 `parentPid`/`childPid`，死的直接转 `failed` 并写 `staleReason`
- 或者 `wfa doctor --fix` 提供显式的僵尸清理入口
- 锁超时的错误信息应指出「被哪个 task id / pid 占用」，而不只是一句 retry

---

## U12 `.store.lock` 持有者已死，但锁无法删除或改名

**现象**：`.store.lock` 内容为 `{"pid":20012,...}`，`tasklist /FI "PID eq 20012"` 无匹配（进程不存在）。清理尝试全部失败：

```
$ mv .store.lock .store.lock.stale-1795282941
mv: cannot move '...\.store.lock' to '...\.store.lock.stale-1795282941': Permission denied

$ rm -f .store.lock
[safe-delete][SAFE_DELETE_BULK_GUARD_ERROR] state lock timeout

PowerShell> [System.IO.File]::Delete($p)
（无输出，文件仍在）
```

**对比**：同一目录下 `touch .write-probe` 成功，说明目录本身可写。因此不是磁盘权限，而是该文件被某个句柄持续持有（delete-pending 或杀软扫描）。

**影响**：配合 U11，形成死锁：任务状态卡住 → 锁不释放 → 手工清理锁又失败。这次最终是靠手工改 `tasks.json` 才恢复了一半，锁仍然在。

**期望**：
- 锁文件写到独立子目录（如 `.locks/store.lock`），整目录可重建
- 或者用 `tasks.json` 旁的 `*-journal` 而非独立锁文件
- 提供 `wfa doctor --force-unlock`，走 `rename` 到随机名再删除的路径，并在失败时打印持有句柄的进程
- 锁超时前先做一次 `pidAlive` 强校验，而不是只依赖 `open(..., "wx")` 的 EEXIST

---

## U13 自动把工作区 git remote 注入 `repoReference`

**现象**：`wfa ask` 未加 `--no-repo` 时，任务元数据里出现：

```json
"repoReference": {"url": "https://github.com/<owner>/<repo>", "branch": "main", "commit": "<sha>"}
```

并且 provider 会**真的去读这个远程仓库**，而不是只读 prompt。

**两条实际后果**：

1. Gemini 直接拒答，`response.md` 全文只有：

```
The repository URL provided (`https://github.com/...`) cannot be accessed because
no repository-reading or web-fetching tools are available in this environment.

REPO_UNREADABLE
```

而本次 prompt 里**不含任何 URL**（已 `grep -nE "https?://"` 验证为空）。也就是说 provider 拿到的是一个它读不到、又以为必须读的引用，于是放弃回答。

2. ChatGPT 的回答里出现「已成功读取 `<repo>` 指定提交 `<sha>`」并据此做代码核查，但那个提交**不包含**待审的脚本文件（工作副本的未提交改动看不到）。基于旧快照得出的结论看起来权威，实则与本地现场不符。

**影响**：
- 违反「数据不上传、日常离线」的使用前提：私有仓库 URL 与 commit 被送进第三方会话
- 用本地未提交内容提问时，provider 审的是远程旧版本，答案与现场错位
- 对 Gemini 直接导致零产出

**期望**：
- **默认 `--no-repo`**，需要仓库引用时显式 `--repo-url` 或 `--bundle-repo`
- 注入前打印一行提示（「已注入 repoReference: <url>@<sha>，用 --no-repo 关闭」）
- provider 读到不可访问的 repo 时，应忽略该引用继续回答，而不是整体拒答

---

## U14 写 `metadata.json` 报 `os error 5`，任务被判 failed

**现象**：

```
[batch] job wfa-gemini-caaea983: failed (failed to persist metadata.json:
Failed to finalize ...\ask-bridge-output\wfa-gemini-caaea983\metadata.json: 拒绝访问。 (os error 5))
```

同目录下残留 `.metadata.json.tmp-36680`（185 字节），`metadata.json` 停在 `"state":"in_progress"`。

**影响**：回答已经生成（`response.md` 存在），但因为元数据落盘失败，整个任务判 failed；随后又触发 U11 的僵尸状态。也就是说**一次写入失败会连带三件事**：结果丢失、状态卡住、锁卡住。

**期望**：
- 元数据写入失败不应否定已产出的 `response.md`；应标记 `degraded` 并把正文保留在可收集位置
- 重试一次（换临时文件名）；仍失败时写 `.metadata.failed.json` 说明原因
- `os error 5` 在 Windows 上常见于杀软扫描或另一个句柄未关，错误信息应带上目标路径与持有者推断

---

## U15 `mkdir` 数据家目录报 `EPERM`

**现象**：

```
wfa: EPERM: operation not permitted, mkdir 'C:\Users\<user>\AppData\Local\web-first-ask'
```

**上下文**：该目录**已存在**且 `touch` 可写。报错发生在 `mkdir(..., {recursive:true})` 路径上，说明 wfa 把「目录已存在」判成了「无法创建」。

**影响**：命令在进入业务逻辑之前就退出，用户看到的是权限错误，实际是幂等判断写错了。

**期望**：`mkdir` 的 `EEXIST`（以及 Windows 的 `EPERM` 变体）在 `recursive: true` 下应视为成功；真正的权限问题留给后续 `open` 报错，并在信息里给出实际路径。

---

## U16 长生成被判 `stalled` 并杀进程（2026-11-22 04:05 复现，0.2.9 已修）

**现象**：`wfa code` 让 Gemini 输出约 300–400 行 C#，第 300 秒报 `gemini: stalled` / `PROVIDER_ERROR`，同秒 batch 收到 `Shutting down (stdin end)`，生成被中断；随后 `wfa collect` 只得到 `No trusted ask-bridge completed metadata`。

**根因**：`stall-watch` 的存活证据只有两种——含 job id 的进度行、`metadata.json` 的 mtime。ask-bridge 在**等待模型生成**期间两者都不产生，只有结束才写。于是「合法但较长」的生成与「页面卡死」在 wfa 眼里完全一致，5 分钟阈值直接切在正常区间的中间。

**已修**：`runner-stall` 与 `policy-store` 的 detached 判定共用同一否决——判定 stall 前看 ask-bridge 的 `chrome-devtools-mcp.log` mtime，120 秒内有写入就认为浏览器还在被驱动，只打一行说明并继续等（窗口固定，不随 `--stall-timeout` 放大；生成期该日志约每 200 ms 写一次）。默认阈值同时提到 900 s 作为兜底。日志文件不存在时维持原行为（只有静默证据）。

## U17 批次运行期 CLI 全程静默（2026-11-22 03:32 复现，0.2.9 已修）

**现象**：`wfa code` 后台跑 10 分钟，`--json` 输出文件始终 0 字节，调用方的后台任务登记还丢了句柄；只能靠 `.store.lock` 里的 pid 加 `tasklist` 判活。

**已修**：`guardedBatch` 每 60 s 通过进度通道打一行 `[wfa] still waiting: gemini quiet 240s (stall limit 900s)`。合成行不进 `batch.stdout.log`、不含 job id，因此不会被当成 provider 进度、也不会重置自身的静默计时。反过来用：这行停了，就说明进程没了。

## U18 附件打不开仍按 `completed` 收敛（2026-11-22 03:56 复现，0.2.9 已修）

**现象**：`--bundle-repo=zip` 跟发后 `state: completed`，但正文是「当前会话环境中没有可用的文件解压或本地文件读取工具……此处不编造未经核对的代码块」，零可用产出。

**已修**：`inspectResponseHeuristics` 增加附件拒绝特征（中英），命中时在 `wfa code` 与 `wfa status` 都打警告，说明附件很可能没被使用、该改发文本或给可达 URL。仍是 `completed` —— 任务确实完成，只是产出没用上附件，所以用警告而不是假造一个新的失败态。

## U19 `--detach` 启动的 worker 立即消失，任务落 `needs_recovery`（2026-11-22 10:05 复现，0.2.9 已修判定）

**现象**：`wfa ask --detach` 正常打印 `Started task <id>; detached worker`，`wfa status` 立刻是 `running`，两个 provider `queued`。约 1 分钟后变成 `needs_recovery`，两个 provider 都是 `interrupted_unknown`：

```
ask-bridge process is no longer running and no trusted terminal artifact was found.
The prompt may already have been submitted; do not resend.
```

**证据**：run 目录只有 `jobs.jsonl` 和两个 **0 字节**的 `batch.stdout.log` / `batch.stderr.log`，`ask-bridge-output/` 为空；`ps` 里没有 ask-bridge，也没有 Chrome。

**复现**：

```bash
wfa ask --no-repo --workspace <新名> --prompt-file note.md --timeout 1800 --detach
# 等待 60–90 秒
wfa status <task-id>
```

**绕过**：不用 `--detach`，把 `wfa ask` 本身放进调用方的后台任务里。同一 prompt、同一 workspace 规则、只换 workspace 名重发，Gemini 75 秒正常完成（run `ade9f7bd`），说明问题在 detach 的进程托管，不在 provider 或 prompt。

**推测（已否证）**：原以为是 detach worker 的 stdin 一关就退出。实测不是。

**实测原因（2026-11-22 13:40）**：`spawn` 的三个关键点都对——`detached: true`、`stdio: ["ignore", fd, fd]`、`unref()`，而且用 wfa 自己的 `spawnDetached` 在隔离脚本里启动同一个 `ask-bridge.exe batch`，父进程退出后它照样死。用同一个 launcher 起一个每 300 ms 写心跳的 `node -e`，父进程退出后心跳停在 10 行。**父进程活着时一切正常**：把 `spawnDetached` 返回前临时挂住 8 秒，同一任务跑到 `exit code=0`、`batch.stdout.log` 412 字节。

也就是说，终止方不是 wfa、不是 ask-bridge、也不是 stdin，而是**调用方宿主的进程树清理**：本机 agent 的 shell 执行器在一个工具调用结束时收掉整棵树，`detached` 标志只能脱离控制台，脱不出这个 job。同一个 `--detach` 在普通终端里预期仍然有效，所以 wfa 不拒绝它。

**修复（0.2.9）**：ask-bridge 的启动横幅是直接写进 `batch.stdout.log` 的，所以**两个 batch 日志都是 0 字节**只能说明 batch 还没说第一句话，任何 provider 都没见到 prompt。`refreshTask` 对 `detached` 任务用这条判据：满足即记 `failed_before_start`（`task.state` 为 `failed`，不占工作区锁，可直接重跑），并在错误里点明宿主清理与两条出路；有任何一个字节的日志就维持 `interrupted_unknown` + `needs_recovery`（可能已提交，不自动重试）。前台任务不适用该判据——它的 stdout 由 runner 缓存在内存里、批次结束才落盘，0 字节不代表没提交。

**给使用者的结论**：在会清理后台进程的宿主（IDE / agent 的执行器）里，`--detach` 保不住 worker。把 `wfa ask` 本身放进宿主的后台任务，或直接前台跑。



U11–U15 里只有 U14 的一半在 ask-bridge 侧，其余都在 wfa 或本机守卫，已在 0.2.8 处理。

### 实测到的真实原因

- **`%LOCALAPPDATA%` 的写入会被间歇性拦截**，与卷无关。同一路径同一进程：

  | 操作 | 结果 |
  | --- | --- |
  | 新建文件 | 1 ms |
  | 覆写已存在文件 | 15,607 ms；另一次 30,120 ms 后 `EPERM` |
  | 追加到已存在文件 | `EPERM` |
  | 删除文件 | `EPERM` |
  | 覆写工作区（`H://`）文件 | 1 ms |

  两小时后同一目录的覆写回到 0–6 ms。也就是说这是守卫自身 state lock 卡死期间的**瞬时**表现（它的 stale 窗口过期后自愈），不是磁盘权限，也不是 wfa 独有。U12 里 `mv` 报 Permission denied、`rm` 报 state lock timeout 都是同一状态。
- 因此 `tasks.json` 的每次落盘（`writeJsonAtomic` = 临时文件 + rename 覆写）都可能变成 15–30 秒。一个事务写两份文件，两个会话就会互相把 15 秒的等待预算吃光——这解释了「两个会话同时调用 wfa」后立刻全盘 `STORE_LOCK_TIMEOUT`。

### 已修

1. **读不取写锁**：`Store.snapshot()` 直接读两份 JSON。`wfa list`、`wfa status` 在锁被占时依然可用。
2. **`--no-refresh` 生效**：它此前被解析但从未判断，`wfa list --no-refresh` 仍会对最多 20 个任务各跑一次写事务。现在真正跳过，且刷新改为顺序执行，避免一批锁等待者。
3. **失效锁接管**：`wfa unlock` 走「rename 到 `*.stale-<token>-<ts>` → 删除」，并先用独立 claim 文件串行化接管者、再复验锁的代次（token + pid + createdAt），避免两个等待者互相移走对方新建的锁。rename 与 unlink 都失败时报 `STORE_LOCK_UNRECLAIMABLE`，写明路径、持有者与两条出路（`wfa unlock` / 换 `WFA_HOME`）。
4. **等待可观察**：争锁超过 750 ms 向 stderr 打一行，含持有者 pid、host、锁龄与完整路径；超时错误同样带这些字段，不再只说 retry。
5. **按需写入**：事务只重写内容真正变化的文件。只改 `tasks.json` 的事务不再顺带覆写 `sessions.json`，在慢盘上直接省掉一次 15–30 秒。
6. **外部探测移出锁**：`checkAskBridge` 不再在任务创建事务内执行。
7. **`mkdir` 幂等**：目录已存在（含 Windows 的 `EPERM` 变体）即视为成功。
8. **U14 不再丢答案**：`metadata.json` 落盘失败但 `response.md` 存在时，任务记 `completed` 并带 `degradedReason: METADATA_PERSIST_FAILED`，正文可取。
9. **U13 发送前告知**：注入 `repoReference` 时打印 `url@commit` 并提示 `--no-repo` / `--bundle-repo=zip`。默认仍是注入——改成默认关闭会改变现有语义，留给 0.3.0 决定。
10. **`wfa doctor` 增加存储写入探针**：分别测一次覆写和一次 rename 覆写，超过 2 秒标 `SLOW` 并提示换 `WFA_HOME`；Chrome 与 ask-bridge 检查前先打一行进度，避免「无输出=卡死」的误判。
11. **`wfa --version`** 此前报 `Unknown command "--version"`，现在直接读 `package.json`，不建 Store。

### 验证

- 三个曾被判定「废掉」的 home（`web-first-ask`、`-2`、`-3`）用 `wfa unlock` 全部清掉；随后 `wfa list --no-refresh` 分别 236 / 215 / 250 ms 返回（此前 15 秒超时）。
- 6 个进程同时抢一个失效锁，临界区写入时间戳，连跑 5 轮无一次区间重叠。
- 全套 `node --test tests` 通过（本地 Windows，含上述竞态用例）。

以上第 2、4、5、6 条来自 ask-bridge 侧评审（ChatGPT 读本仓 zip 后给出），其中「rename 自动接管不安全」的 ABA 反例成立，最终实现改成 claim + 代次复验。

---

## 对外部记录 WFA-01…08 的复核（2026-11-22 09:40，wfa 0.2.9）

另一个会话在 0.2.7 上留了一份故障记录。逐条复跑后的结论：

| 编号 | 结论 | 依据 |
| --- | --- | --- |
| WFA-01 sandbox-center 杀 node | 环境问题，不属 wfa | 本轮 `doctor`、`code --dry-run` 均正常，未出现无输出 |
| WFA-02 锁永久死锁，home 报废 | 0.2.7 现象；0.2.9 自愈 | 伪造一份死 pid 的 `.store.lock`，0.27 s 内完成接管与写入。只有宿主守卫同时拦住 rename 与 unlink 时才留 `STORE_LOCK_UNRECLAIMABLE` |
| WFA-03 `code --dry-run` 静默挂起 | 0.2.9 未复现 | 同一仓库同一参数 0.47 s 返回完整 preview。当时 5 s 的 `git` 超时只是被瞬时写过滤器拖慢的表象，不是判定 bug |
| WFA-04 safe-delete 守卫自锁 | 外来守卫，非 wfa | 报错与副作用不一致（报失败但已改名）；wfa 侧只能靠 U12 的接管路径绕开 |
| WFA-05 `NODE_OPTIONS` shim 干扰 | 未证实，未复现 | 清空与不清空 `NODE_OPTIONS` 跑同一组命令无可测差异 |
| WFA-06 后台句柄丢失 + 全程静默 | 静默部分已修（U17）；句柄丢失属调用方 | 工具侧后台任务登记丢了 pid，wfa 进程仍在跑并持锁——这是调用方的事 |
| WFA-07 zip 打不开却 completed | 已修（U18） | — |
| WFA-08 长生成被 stall 误杀 | 已修（U16） | — |

关于「两个会话同时用 wfa」：那不是锁被抢，而是**同一 home 的串行化加上写被拦截**。`tasks.json` 每次落盘是临时文件 + rename 覆写，被守卫拦住时单次要 15–30 s，一个事务写两份文件；两个会话轮流争锁时，60 s 的等待预算会被前一个会话的两三次慢写吃光，看起来就像「锁卡死」。不同会话各用一个 `WFA_HOME` 即可完全避开，`wfa list`/`status` 在 0.2.8 起也不再需要写锁。

---

## 建议优先级

- **P0**：U2（静默截断产生「看起来正常」的错误结论）、U4（答非所问且难察觉）、U1（文件名匹配把正常附件判成未附加，白扔 50 秒）、U10（串行必挂一次）、U11（僵尸任务让全部命令不可用）、U12（锁无法清理，与 U11 形成死锁）
- **P1**：U3（长产物取不到）、U5（输出不可直接用）、U9（其余判定的地基）、U13（默认上传远程仓库地址，且让 Gemini 零产出）、U14（一次写失败连带丢结果+卡状态+卡锁）
- **P2**：U6、U8、U15
- **已修（0.4.0）**：U7（CDP `Browser.close` + `--headless` 默认 `true`）

**U11 + U12 是最致命的一组**：两者互相放大，且都没有官方自救入口。用户能看到的只有一句 `retry the status command`，而重试永远不会成功。

---

## wfa 侧已做（不在本清单）

wfa 0.2.3 起：

- 正文超 40 KiB 在发送前拦截（`PROMPT_OVERSIZE`）；`--dry-run` 给文件级 `splitPlan`；`--allow-oversize` 放行。
- Gemini 遇到归档附件（zip/tar/gz/tgz/7z）走原生上传，且归档名压到 17 字符（`<slug8>-<hex8>.zip`），否则会撞 U1；文本附件自动内联（带行号的源码包直接内联），既避开 U1 的整名匹配，也避免把上传通道当传输层；其它二进制/原生文档提前拒绝（`GEMINI_ATTACHMENT_UNSUPPORTED`）；`--allow-gemini-attachments` 强制走原生上传——此时附件名同样要保持 stem ≤ 20 字符。
- `response.md` 出现 Canvas 存根特征或 `\vert{}` 类转义时标记 `responseHeuristics` 并在 CLI 警告，不修改正文；stage/apply 拒绝含污染的内容。
- `--new-session` 完成后比对上一轮 `threadUrl`，相同则记 `sessionIsolationWarning`。
- 默认 chatgpt + gemini，多 provider 默认串行（`--concurrency 1`）；由 WFA 自行拆分为独立单 job 请求，含 `--detach` 模式。
- 预提交 tab 关闭的有限重试保留独立 stdout/stderr 文件；不自动重试可能已提交的请求。
- Chrome `Preferences` 崩溃恢复标志修复和日志轮转已集成到 WFA 启动路径与 `doctor`；外部 wrapper 不再是启动前提。
- 可证明未提交的失败（tab 打开失败、Send 按钮未激活、附件上传超时）自动解锁 workspace。

以上都只是**检测与规避**，不是修复：U1–U10 的根因仍在 ask-bridge。
