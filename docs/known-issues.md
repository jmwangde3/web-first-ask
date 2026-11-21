# ask-bridge 上游问题清单

> **范围**：只保留必须由 ask-bridge（Rust 二进制）修的问题。wfa 侧能提前拦截、标注或绕过的，已落实的规避方案见文末「wfa 侧已做」，不占本清单。
> **环境**：Windows 11 zh-CN / Git Bash / ask-bridge 0.4.0 / wfa 0.2.2→0.2.3 / Chrome headful（`--window-position=-2000,-2000`）/ providers: ChatGPT + Gemini。
> **证据**：2026-11-21 单机实测，命令与时间均为真实运行结果；run 目录可复核。

## 汇总

| 编号 | 问题 | 级别 | wfa 侧现状 |
| --- | --- | --- | --- |
| U1 | Gemini 文档附件上传超时（归档不受影响） | 阻断 | 归档原生上传；文本内联；文档类提前拒绝 |
| U2 | prompt > 约 44 KiB 静默截断 | 阻断 | 40 KiB 拦截并给拆分计划 |
| U3 | ChatGPT 长产物进 Canvas，`response.md` 只有链接 | 阻断 | 检测并警告 |
| U4 | `--new-session` 复用旧会话 | 严重 | 比对 threadUrl 并警告 |
| U5 | Gemini 输出被二次转义 | 严重 | 检测并在 stage/apply 阻断 |
| U6 | 双 provider 并发不稳定 | 一般 | 默认串行 |
| U7 | Chrome `exit_type` 停在 `Crashed`，弹恢复气泡 | 一般 | wfa 启动前修复并在 doctor 报告 |
| U8 | `chrome-devtools-mcp.log` 无轮转 | 一般 | wfa 启动前按 64 MiB/4 MiB 门槛轮转 |
| U9 | 缺 `submissionState` 等提交证明字段 | 设计 | 靠错误文本推断 |
| U10 | `--concurrency 1` 串行批次也关掉上一个 job 的标签页 | 阻断 | wfa 自行拆为多个独立单 job 批次（含 detach） |
| U11 | 僵尸 `running` 任务让 `list`/`status`/`resolve` 全部锁超时 | 阻断 | 0.2.8：读路径不再取写锁；`--no-refresh` 真正生效；锁等待打印持有者 |
| U12 | `.store.lock` 持有者已死但无法删除或改名 | 阻断 | 0.2.8：`wfa unlock` 接管（rename 优先 + 代次复验）；失败时报 `STORE_LOCK_UNRECLAIMABLE` 并给出路 |
| U13 | 自动把工作区 git remote 注入 `repoReference` | 严重 | 0.2.8：发送前打印被注入的 `url@commit`；默认仍注入，`--no-repo` 关闭 |
| U14 | 写 `metadata.json` 报 `os error 5`，任务被判 failed | 严重 | 0.2.8：`response.md` 存在时记 `completed` + `degradedReason`，不再丢答案 |
| U15 | `mkdir` 数据家目录报 `EPERM` | 严重 | 0.2.8：目录已存在即视为成功，真权限问题留到 `open` |

---

## U1 Gemini 附件上传必然超时

> **2026-11-21 修正**：这条只对**需要解析的文档**（`.md` / `.txt` / `.pdf` / `.docx` / `.xlsx` 等）成立。**归档文件不受影响**：同一个 132 KB 的 `.zip` 通过 `ask-bridge --backend browser batch` 送达 Gemini 只用了 **15 秒**，回答正确说出「70 个条目，约 60 个文件」。所以 wfa 现在对 zip/tar/gz/tgz/7z 放行原生上传，只有文档类附件才内联或提前拒绝，整仓交付改走 `--bundle-repo=zip`。

**现象**：给 Gemini 带需要解析的文档附件，50–54 秒后失败：

```
Timed out waiting for Gemini to show attachment 'skein-source-bundle-191ae7c.md'   elapsed=54s
Timed out waiting for Gemini to show attachment 'skein-source-bundle-191ae7c.txt'  elapsed=50s
Timed out waiting for Gemini to show attachment 'source-bundle-e7430cb187f7.txt'   elapsed=50s
```

**复现**：

```bash
wfa ask --provider gemini --prompt "读一下附件" --file note.md --timeout 300
```

同内容内联进 prompt 就成功，说明与文件内容无关，是上传/解析通道，不是附件体积。

**期望**：上传控件选择器或完成判定已过期。要么修好，要么在上传阶段暴露可观察状态（开始/已选中/进度/UI 确认），失败时立刻报错，而不是干等 50 秒再抛一句 timeout。短期无法修时，元数据至少给 `attachmentState: not_started | uploading | attached | failed`。

**影响**：Gemini 这一路的**文档**附件不可用，只能内联，而内联又会撞 U2；**归档**附件可用，所以整仓交付走 `--bundle-repo=zip`。

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

## U7 Chrome `exit_type` 停在 `Crashed`，弹恢复气泡

**根因**：`ask-bridge batch` 没有 headless 参数，实际以 headful 启动 Chrome 并用 `--window-position=-2000,-2000` 把窗口挪到屏幕外；退出时强杀进程，`chrome-profile/Default/Preferences` 里的 `profile.exit_type` 停在 `Crashed`。下次启动读到就弹「恢复页面」气泡，而该气泡是独立窗口，不受离屏坐标约束，会直接出现在屏幕上。

**期望**：进程内优雅关闭（CDP `Browser.close` 后等退出），或退出前主动把 `exit_type` 写回 `Normal`；也可以直接给 Chrome 传 `--hide-crash-restore-bubble`。

**影响**：每次调用都可能弹一个窗口打断用户。wfa 现在启动前原子改写识别到的 `Preferences`，不再需要独立包装脚本；这仍不是上游优雅退出的根因修复。

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

**复现**：任意两 provider 串行批次。两种顺序（`chatgpt,gemini` 与 `gemini,chatgpt`）都复现，**总是第二个 job 挂**，与 provider 无关。

**期望**：串行批次内可以复用同一个页面直到整批结束，或下一个 job 新建页面而不是拿着已关闭的 page id 去 `list_pages`。

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

## wfa 0.2.8 修复与实测（2026-11-22 02:20）

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

## 建议优先级

- **P0**：U2（静默截断产生「看起来正常」的错误结论）、U4（答非所问且难察觉）、U1（Gemini 附件完全不可用）、U10（串行必挂一次）、U11（僵尸任务让全部命令不可用）、U12（锁无法清理，与 U11 形成死锁）
- **P1**：U3（长产物取不到）、U5（输出不可直接用）、U9（其余判定的地基）、U13（默认上传远程仓库地址，且让 Gemini 零产出）、U14（一次写失败连带丢结果+卡状态+卡锁）
- **P2**：U6、U7、U8、U15

**U11 + U12 是最致命的一组**：两者互相放大，且都没有官方自救入口。用户能看到的只有一句 `retry the status command`，而重试永远不会成功。

---

## wfa 侧已做（不在本清单）

wfa 0.2.3 起：

- 正文超 40 KiB 在发送前拦截（`PROMPT_OVERSIZE`）；`--dry-run` 给文件级 `splitPlan`；`--allow-oversize` 放行。
- Gemini 遇到归档附件（zip/tar/gz/tgz/7z）走原生上传；文本附件自动内联（带行号的源码包直接内联）；其它二进制/原生文档提前拒绝（`GEMINI_ATTACHMENT_UNSUPPORTED`）；`--allow-gemini-attachments` 强制走原生上传。
- `response.md` 出现 Canvas 存根特征或 `\vert{}` 类转义时标记 `responseHeuristics` 并在 CLI 警告，不修改正文；stage/apply 拒绝含污染的内容。
- `--new-session` 完成后比对上一轮 `threadUrl`，相同则记 `sessionIsolationWarning`。
- 默认 chatgpt + gemini，多 provider 默认串行（`--concurrency 1`）；由 WFA 自行拆分为独立单 job 请求，含 `--detach` 模式。
- 预提交 tab 关闭的有限重试保留独立 stdout/stderr 文件；不自动重试可能已提交的请求。
- Chrome `Preferences` 崩溃恢复标志修复和日志轮转已集成到 WFA 启动路径与 `doctor`；外部 wrapper 不再是启动前提。
- 可证明未提交的失败（tab 打开失败、Send 按钮未激活、附件上传超时）自动解锁 workspace。

以上都只是**检测与规避**，不是修复：U1–U10 的根因仍在 ask-bridge。
