/**
 * 信号量 - 控制并发数量
 * 
 * sandcastle 实际代码参考: .sandcastle/run.ts 中的 acquire/release
 * 
 * 为什么不用 p-limit 库？
 * 1. 零依赖
 * 2. 24 行代码搞定
 * 3. FIFO 公平队列
 */
export function createSemaphore(maxConcurrency: number) {
    let running = 0;
    const queue: (() => void)[] = [];

    return {
        /**
         * 获取执行许可
         * 如果未达到最大并发数，立即返回
         * 否则排队等待
         */
        acquire(): Promise<void> {
            if (running < maxConcurrency) {
                running++;
                return Promise.resolve();
            }

            // 排队等待
            return new Promise((resolve) => {
                queue.push(() => {
                    running++;
                    resolve();
                });
            });
        },

        /**
         * 释放执行许可
         * 唤醒队列中的下一个任务
         */
        release(): void {
            running--;
            const next = queue.shift();
            if (next) {
                next();
            }
        },
    };
}