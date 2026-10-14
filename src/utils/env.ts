import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 轻量 .env 加载器（不引入 dotenv 依赖）
 *
 * 为什么需要它？
 * merge agent 需要在容器内关闭 GitHub issue / push，
 * 但 GH_TOKEN 只存在于 .env 文件里 —— 不加载的话
 * pickAgentEnvVars() 读到空值，容器内无凭据，
 * issue 关不掉 → run.ts 循环永远不终止。
 *
 * 注意：只填充 shell 中未定义的变量，
 * 不覆盖用户显式 export 的值。
 */
export function loadDotEnv(repoDir: string): void {
    const envPath = join(repoDir, ".env");
    if (!existsSync(envPath)) return;

    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;

        const eq = trimmed.indexOf("=");
        if (eq <= 0) continue;

        const key = trimmed.slice(0, eq).trim();
        const value = trimmed
            .slice(eq + 1)
            .trim()
            .replace(/^["']|["']$/g, "");

        if (process.env[key] === undefined) {
            process.env[key] = value;
        }
    }
}