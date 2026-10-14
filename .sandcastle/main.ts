import { docker } from "../src/providers/docker.js";
import { claudeCode } from "../src/agents/claude.js";
import { piAgent } from "../src/agents/pi.js";
import type { AgentProvider } from "../src/types.js";
import { run } from "../src/run.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 与 .sandcastle/run.ts 保持一致：
 * AGENT=pi (默认) | claude
 * MODEL=kimi-for-coding 等可选
 */
function createAgent(): AgentProvider {
  const agentType = process.env.AGENT ?? "pi";
  const model = process.env.MODEL;
  if (agentType === "claude") {
    return claudeCode(model ?? "claude-sonnet-4");
  }
  return piAgent(model);
}

async function main() {
  const repoDir = process.cwd();
  
  // 读取 prompt
  const prompt = readFileSync(
    join(repoDir, ".sandcastle", "test-prompt.md"),
    "utf-8"
  );
  
  // 运行 Agent
  const result = await run({
    prompt,
    repoDir,
    branch: "sandcastle/test-hello",
    agent: createAgent(),
    sandbox: docker(),
  });
  
  console.log("\n✅ Done!");
  console.log("Exit code:", result.exitCode);
  console.log("Commits:", result.commits.length);
}

main().catch(console.error);