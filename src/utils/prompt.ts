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