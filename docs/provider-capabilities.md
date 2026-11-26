# Provider 沙箱能力矩阵（已核实：2026-11-26）

本表记录真实网页端 provider 沙箱的实测能力，用于指导 `wfa` 派发策略与默认设置。

| Provider / 模式 | 读取 GitHub | 沙箱运行环境（实测） | 代码修改与验证能力 |
| :--- | :--- | :--- | :--- |
| **ChatGPT 网页版** | 可用 GitHub API 读指定 commit 的文件与目录树；**不能 `git clone`**（执行容器解析不了 `github.com`，强制指定 IP 也失败） | Git `2.47.3`、Node `22.16.0`、npm `10.9.2` | 给 `git bundle` 或带 `.git` 的 zip 后，能自建 clone、跑 `git apply --check` / `--stat` 与**完整 `npm test`** |
| **Gemini Chat 模式** | **不能读 GitHub** | 仅 Python `3.10`（无 `node` / `npm` / `git` / `patch`） | 能解压源码 zip、改代码、用 `diff -u` 出补丁；**跑不了 `npm test`** |
| **Gemini Task 模式** | **Pro 账户可 `git clone` 仓库**；免费版账户不可以 | Node `18.20.4`、npm `9.2.0`（不能联网装依赖） | 可在沙箱内运行离线命令（注意 Node 18 与要求 `>=22.15` 项目的版本差异） |

## 默认代码修改契约

- 凡涉及**修改代码**的任务，必须直接向 provider 提供代码包（`git bundle` 或带 `.git` 的源码 zip，可使用 `wfa cdp ask --code-task` 自动打包附加），并在提示词中明确指定让 provider 运行 `git apply --check` 和完整 `npm test`。
- ChatGPT 具备 Node `22.16.0` + Git `2.47.3`，适合作为代码补丁的主验证与 `npm test` 执行环境；Gemini Chat 模式仅适合出 `diff -u` 补丁，无法跑 `npm test`。
