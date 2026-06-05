import { docker } from "../src/providers/docker.js";
import { claudeCode } from "../src/agents/claude.js";
import { run } from "../src/run.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
    agent: claudeCode("claude-sonnet-4"),
    sandbox: docker(),
  });
  
  console.log("\n✅ Done!");
  console.log("Exit code:", result.exitCode);
  console.log("Commits:", result.commits.length);
}

main().catch(console.error);