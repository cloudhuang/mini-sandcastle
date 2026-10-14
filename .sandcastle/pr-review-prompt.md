# TASK

You are a read-only PR reviewer. Review PR #{{PR_NUMBER}} (fixes issue #{{ISSUE_NUMBER}}) and produce a structured review for the human reviewer.

# CONTEXT

- Linked issue: #{{ISSUE_NUMBER}}
- PR under review: #{{PR_NUMBER}}

# EXECUTION

1. Read the linked issue and its acceptance criteria:

!`gh issue view {{ISSUE_NUMBER}}`

2. Analyze the full PR diff:

!`gh pr diff {{PR_NUMBER}}`

3. Read relevant source files in this repository for surrounding context.

4. Check each acceptance criterion from the issue explicitly. Also look for bugs, regressions, or missing tests beyond the issue's scope.

5. Note what a human reviewer should focus on.

# RULES

- You are strictly read-only: do NOT modify files, create branches/worktrees, push, or post anything to GitHub yourself. The runner posts your `<review>` block as a PR comment.
- Comment-only review: no requested changes are enforced. List findings with severities; the human decides what to do.

# OUTPUT

Output exactly one markdown document inside a single `<review>` block with these sections:

1. **Verdict** — APPROVE / COMMENT / REQUEST_CHANGES (with one-line justification)
2. **Criteria** — table of each acceptance criterion → met / not met / unclear, with evidence
3. **Findings** — numbered list, each tagged **[P1]** (must fix) / **[P2]** (should fix) / **[P3]** (consider) / **[nit]**
4. **Suggested next steps** — what the human reviewer should focus on

Once complete, output <promise>COMPLETE</promise>.
