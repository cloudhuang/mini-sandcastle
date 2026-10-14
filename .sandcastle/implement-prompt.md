# TASK

Fix issue #{{ISSUE_NUMBER}}: {{ISSUE_TITLE}}

Work on branch {{BRANCH}}.

# CRITICAL RULES

1. **DO NOT modify `.git` file** - It is a gitlink pointing to the real repo. Never run `git init`, `rm .git`, or edit `.git`.
2. **DO NOT read unrelated files** - Only read files needed to fix this specific issue.
3. **node_modules is pre-installed** - Do NOT run `npm install`. Use existing node_modules.

# EXECUTION

Step 1: Check what tests expect
```bash
ls test/
npm run test 2>&1 | tail -30
```

Step 2: Make minimal changes to fix the issue

Step 3: Verify
```bash
npm run typecheck && npm run test
```

Step 4: Commit
```bash
git add <files>
git commit -m "RALPH: Fix {{ISSUE_TITLE}} (issue #{{ISSUE_NUMBER}})"
```

Once complete, output <promise>COMPLETE</promise>.
