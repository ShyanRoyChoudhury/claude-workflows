# Example run: feature with a DB schema change

A walkthrough of the two-invocation flow you hit whenever the work needs a schema change.

## 1. Launch

```js
Workflow({
  name: 'build-review-pr',
  args: {
    requirement: 'Track last_login_at for users: set it on successful login, expose it in GET /api/me, add tests',
    repoPath: '/Users/you/code/my-app',
    baseBranch: 'main',
  },
})
```

The builder implements the feature on `feat/track-last-login`, writes `migrations/0042_add_last_login_at.sql`, but does **not** run it. The run pauses:

```json
{
  "status": "awaiting_db_approval",
  "branch": "feat/track-last-login",
  "pausedAfter": "the initial build",
  "pendingDbChanges": [
    {
      "description": "Add nullable last_login_at timestamp to users",
      "migrationFile": "migrations/0042_add_last_login_at.sql",
      "sql": "ALTER TABLE users ADD COLUMN last_login_at timestamptz;"
    }
  ]
}
```

## 2. Human applies the change, then resume

You review the SQL, run it against your database (or approve it for your migration pipeline), then resume — note `resumeFromRunId` (printed when the first run launched) and the appended `approvedDbChanges`:

```js
Workflow({
  name: 'build-review-pr',
  resumeFromRunId: 'wf_abc123-def',
  args: {
    requirement: 'Track last_login_at for users: set it on successful login, expose it in GET /api/me, add tests',
    repoPath: '/Users/you/code/my-app',
    baseBranch: 'main',
    approvedDbChanges: ['migrations/0042_add_last_login_at.sql'],
  },
})
```

The builder's result replays from cache (no re-run, no tokens re-spent). The review loop runs: round 1 finds two blocking issues (a missing null-check and an untested code path), the fixer addresses both, round 2 verifies the fixes and comes back clean. The PR agent pushes and opens the PR:

```json
{
  "status": "pr_created",
  "prUrl": "https://github.com/you/my-app/pull/87",
  "branch": "feat/track-last-login",
  "reviewHistory": [
    { "round": 1, "blockingIssues": 2, "totalIssues": 5 },
    { "round": 2, "blockingIssues": 0, "totalIssues": 1 }
  ],
  "dbSchemaChanges": [
    { "description": "Add nullable last_login_at timestamp to users", "migrationFile": "migrations/0042_add_last_login_at.sql" }
  ],
  "humanActionNeeded": "Remember: the DB schema changes listed above must be applied to the database by a human — the agents only wrote the migration files."
}
```

The PR body includes a "Database schema changes (apply manually)" section so whoever deploys knows the migration is theirs to run.
