/**
 * 进程级 Shutdown Registry
 * 
 * sandcastle 实际代码参考: src/shutdownRegistry.ts
 * 
 * 为什么需要这个？
 * 1. 多个沙箱并发运行时，每个都注册 SIGINT 监听器会触发 MaxListenersExceededWarning
 * 2. 信号处理器中不能执行异步操作（进程可能在异步完成前被杀死）
 * 3. 统一处理确保所有沙箱都被清理
 * 
 * GitHub Issue 参考: #630
 */

export type ShutdownCallback = () => void;

const callbacks = new Set<ShutdownCallback>();
let listenersInstalled = false;

function runTeardowns(): void {
    for (const cb of callbacks) {
        try {
            cb();
        } catch {
            // 一个 teardown 失败不能阻塞其他
        }
    }
}

function handleSignal(): void {
    // 先 detach，避免 exit 事件重复触发
    detachListeners();
    runTeardowns();
    process.exit(1);
}

function handleExit(): void {
    runTeardowns();
}

function attachListeners(): void {
    if (listenersInstalled) return;
    listenersInstalled = true;
    process.on("exit", handleExit);
    process.on("SIGINT", handleSignal);
    process.on("SIGTERM", handleSignal);
}

function detachListeners(): void {
    if (!listenersInstalled) return;
    listenersInstalled = false;
    process.removeListener("exit", handleExit);
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
}

/**
 * 注册 shutdown 时的清理回调
 * @returns 注销函数
 */
export function registerShutdown(cleanup: ShutdownCallback): () => void {
    callbacks.add(cleanup);
    attachListeners();

    let active = true;
    return () => {
        if (!active) return;
        active = false;
        callbacks.delete(cleanup);
        if (callbacks.size === 0) {
            detachListeners();
        }
    };
}