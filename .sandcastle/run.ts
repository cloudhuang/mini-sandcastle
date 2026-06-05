import { docker } from "../src/providers/docker.js";
import { claudeCode } from "../src/agents/claude.js";
import { run } from "../src/run.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runParallel } from "../src/run-parallel.js";

const repoDir = process.cwd();
const MAX_ITERATIONS = 10;
const MAX_PARALLEL = 4;

/**
 * 读取 prompt 文件并替换模板变量
 */
function loadPrompt(
  filePath: string,
  vars: Record<string, string> = {},
): string {
  let content = readFileSync(join(repoDir, filePath), "utf-8");
  for (const [key, value] of Object.entries(vars)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }
  return content;
}

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

  // Phase 1: Plan
  const plan = await run({
    name: "Planner",
    repoDir,
    branch: `sandcastle/plan-${iteration}`,
    agent: claudeCode("claude-sonnet-4"),
    sandbox: docker(),
    prompt: loadPrompt(".sandcastle/plan-prompt.md"),
  });

  const planMatch = plan.stdout.match(/<plan>([\s\S]*?)<\/plan>/);
  if (!planMatch) {
    throw new Error(
      "Planner did not produce a <plan> tag.\n\n" + plan.stdout,
    );
  }

  const { issues } = JSON.parse(planMatch[1]) as {
    issues: { number: number; title: string; branch: string }[];
  };

  if (issues.length === 0) {
    console.log("No issues to work on. Exiting.");
    break;
  }

  console.log(
    `Planning complete. ${issues.length} issue(s) to work in parallel:`,
  );
  for (const issue of issues) {
    console.log(`  #${issue.number}: ${issue.title} → ${issue.branch}`);
  }

  // Phase 2: Execute + Review
  const tasks = issues.map((issue) => ({
    id: String(issue.number),
    title: issue.title,
    branch: issue.branch,
    prompt: loadPrompt(".sandcastle/implement-prompt.md", {
      TASK_ID: String(issue.number),
      ISSUE_TITLE: issue.title,
      BRANCH: issue.branch,
    }),
  }));

  const settled = await runParallel(
    tasks,
    claudeCode("claude-sonnet-4"),
    docker(),
    repoDir,
    MAX_PARALLEL,
  );

  // Phase 3: Review completed tasks
  const completedIssues: typeof issues = [];
  for (let i = 0; i < issues.length; i++) {
    const outcome = settled[i];
    if (outcome.status === "fulfilled" && outcome.value.success) {
      const result = outcome.value.result;
      if (result.commits.length > 0) {
        completedIssues.push(issues[i]);

        // Review
        await run({
          name: `Reviewer #${issues[i].number}`,
          repoDir,
          branch: issues[i].branch,
          agent: claudeCode("claude-sonnet-4"),
          sandbox: docker(),
          prompt: loadPrompt(".sandcastle/review-prompt.md", {
            TASK_ID: String(issues[i].number),
            ISSUE_TITLE: issues[i].title,
            BRANCH: issues[i].branch,
          }),
        });
      }
    } else {
      console.error(
        `  ✗ #${issues[i].number} (${issues[i].branch}) failed`,
      );
    }
  }

  const completedBranches = completedIssues.map((i) => i.branch);

  console.log(
    `\nExecution complete. ${completedBranches.length} branch(es) with commits:`,
  );
  for (const branch of completedBranches) {
    console.log(`  ${branch}`);
  }

  if (completedBranches.length === 0) {
    console.log("No commits produced. Nothing to merge.");
    continue;
  }

  // Phase 3: Merge
  await run({
    name: "Merger",
    repoDir,
    branch: "sandcastle/merge",
    agent: claudeCode("claude-sonnet-4"),
    sandbox: docker(),
    prompt: loadPrompt(".sandcastle/merge-prompt.md", {
      BRANCHES: completedBranches.map((b) => `- ${b}`).join("\n"),
      ISSUES: completedIssues
        .map((i) => `- #${i.number}: ${i.title}`)
        .join("\n"),
    }),
  });

  console.log("\nBranches merged.");
}

console.log("\nAll done.");
