import { docker } from "../src/providers/docker.js";
import { tmpdir } from "node:os";

const provider = docker();

async function main() {
  const sandbox = await provider.create({
    worktreePath: tmpdir(),
    env: {},
  });

  console.log("Sandbox created. Will exit in 500ms...");

  // 模拟 Ctrl+C
  setTimeout(() => process.kill(process.pid, "SIGINT"), 500);
}

main();
