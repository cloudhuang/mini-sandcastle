import type { AgentProvider, SandboxProvider } from "./types.js";
import { run } from "./run.js";
import { createSemaphore } from "./utils/semaphore.js";

export interface Task {
    readonly id: string;
    readonly title: string;
    readonly prompt: string;
    readonly branch: string;
}

/**
 * 并行运行多个任务
 * 
 * sandcastle 实际代码参考: .sandcastle/run.ts 中的 Promise.allSettled
 */
export async function runParallel(
    tasks: Task[],
    agent: AgentProvider,
    sandbox: SandboxProvider,
    repoDir: string,
    maxParallel: number = 4
) {
    const semaphore = createSemaphore(maxParallel);

    console.log(`\n📋 Running ${tasks.length} tasks (max ${maxParallel} parallel)\n`);

    // Promise.allSettled: 一个任务失败不影响其他任务
    const settled = await Promise.allSettled(
        tasks.map(async (task) => {
            await semaphore.acquire();

            try {
                const result = await run({
                    prompt: task.prompt,
                    repoDir,
                    branch: task.branch,
                    agent,
                    sandbox,
                });

                return { task, result, success: true as const };
            } catch (error) {
                return {
                    task,
                    error: error instanceof Error ? error.message : String(error),
                    success: false as const
                };
            } finally {
                semaphore.release();
            }
        })
    );

    // 报告结果
    const succeeded = settled.filter((r) => r.status === "fulfilled" && r.value.success);
    const failed = settled.filter((r) => r.status === "rejected" || (r.status === "fulfilled" && !r.value.success));

    console.log("\n📊 Results:");
    console.log(`   ✅ Success: ${succeeded.length}/${tasks.length}`);
    console.log(`   ❌ Failed: ${failed.length}/${tasks.length}`);

    for (const outcome of failed) {
        if (outcome.status === "fulfilled") {
            console.log(`   ❌ ${outcome.value.task.id}: ${outcome.value.error}`);
        } else {
            console.log(`   ❌ Unknown error: ${outcome.reason}`);
        }
    }

    return settled;
}