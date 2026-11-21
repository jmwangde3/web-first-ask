export function buildCodePrompt({ requirement, filePaths, context = "", mode = "full-file" }) {
  const files = filePaths.map((file) => `- ${file}`).join("\n");
  const sourceInstruction = files
    ? `## 已指定本地源码或文档\n${files}`
    : "## 源码获取\n请直接读取请求中的 REPOSITORY URL、branch 和 commit；不要等待本地 Agent 粘贴文件。若无法访问仓库，只回复 REPO_UNREADABLE。";
  if (mode === "spec") {
    return `你是本地 Coding Agent 的技术设计负责人。请基于实际源码，输出可直接交给本地 Coding Agent 执行的精确实施规格，而不是完整文件。

## 需求目标
${requirement.trim()}

${sourceInstruction}

${context.trim() ? `## 补充上下文\n${context.trim()}\n` : ""}

## 强制交付格式
1. **结论与方案**：明确推荐方案和关键取舍。
2. **逐文件规格**：每个文件写出路径、目标函数/类/符号、当前行为、修改后行为和关键逻辑。
3. **接口与状态变化**：给出准确的函数签名、数据结构、状态转换和持久化字段。
4. **不变量**：明确哪些现有行为必须保持，尤其幂等、并发、权限和恢复边界。
5. **失败路径**：列出超时、重试、重复提交、部分成功、回滚和兼容性风险。
6. **测试断言**：列出有信息价值的回归场景和可观察的预期结果。
7. **实施顺序**：按依赖关系给出最短执行顺序。

引用源码时使用真实文件路径和可验证的行号。不确定的实现细节标记为待核实，不要编造仓库中不存在的接口。`;
  }

  return `你是本地 Coding Agent 的直接代码实现协作者。请完成代码修改，并输出每个改动文件的完整、可直接保存的全部内容；不要只给方案或 diff。

## 修改目标
${requirement.trim()}

${sourceInstruction}

${context.trim() ? `## 补充上下文\n${context.trim()}\n` : ""}

## 强制交付格式
1. 对每个需要修改或新增的文件，先写 \`FILE: 相对仓库路径\`，随后给出该文件完整内容。
2. 不得输出 diff 代替完整文件；也不得用伪代码、省略号、"其余不变"或占位符省略实现。
3. 根据仓库指定 commit 中的真实版本修改；不要假设未读取的代码或接口存在。
4. 如需新增测试、配置、文档或类型，也提供完整文件内容。
5. 保留现有架构、依赖和兼容性；不做无关重构。
6. 引用源码时使用准确的 \`path:line\`，不要臆造行号。
7. 输出代码后简要说明关键变化、需要本地执行的测试和未验证风险；不得声称未运行的测试已通过。`;
}

export function buildComparePrompt(prompt, mode = "full-file") {
  return `${prompt.trim()}

请独立完成本次任务，不要假设其他 Provider 的观点或答案。明确给出自己的结论与依据；若这是代码任务，${mode === "spec" ? "遵守精确实施规格交付契约，不要输出完整替换文件。" : "遵守完整文件交付契约，返回可直接保存的完整代码，而不是仅给修改方案。"}`;
}
