import { readFileSync } from "node:fs";

/**
 * Prompt 参数
 */
export type PromptArgs = Record<string, string>;

/**
 * 读取 prompt 文件并替换变量
 * 
 * sandcastle 实际代码参考: src/PromptArgumentSubstitution.ts
 * 
 * 支持 {{VARIABLE}} 语法
 */
export function loadPrompt(
    filePath: string,
    args: PromptArgs = {}
): string {
    let content = readFileSync(filePath, "utf-8");

    for (const [key, value] of Object.entries(args)) {
        content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
    }

    return content;
}

/**
 * 提取 stdout 中 <tag>...</tag> 包裹的内容块
 *
 * Agent 的完整 stdout 往往混杂思考过程与其他输出，
 * runner 只取标签内的结构化内容：
 * - Phase 1 Planner 的 <plan> JSON
 * - Phase 5 PR Reviewer 的 <review> markdown
 *
 * 无匹配时返回 undefined（调用方决定是报错还是降级继续）
 */
export function extractTagBlock(
    content: string,
    tag: string
): string | undefined {
    const match = content.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
    return match ? match[1].trim() : undefined;
}

/**
 * 内置参数
 */
export function getBuiltinArgs(
    branch: string,
    targetBranch: string
): PromptArgs {
    return {
        SOURCE_BRANCH: branch,
        TARGET_BRANCH: targetBranch,
    };
}