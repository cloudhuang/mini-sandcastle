import { docker } from "../src/providers/docker.js";
import { claudeCode } from "../src/agents/claude.js";
import { runParallel } from "../src/run-parallel.js";

const tasks = [
    {
        id: "task-1",
        title: "Create utils",
        branch: "sandcastle/task-1",
        prompt: `Create src/utils/math.ts with add/subtract functions. Commit. Output <promise>COMPLETE</promise>`,
    },
    {
        id: "task-2",
        title: "Create types",
        branch: "sandcastle/task-2",
        prompt: `Create src/types/person.ts with a Person interface. Commit. Output <promise>COMPLETE</promise>`,
    },
];

await runParallel(
    tasks,
    claudeCode("claude-sonnet-4"),
    docker(),
    process.cwd(),
    2 // 最多 2 个并行
);