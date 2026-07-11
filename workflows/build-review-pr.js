export const meta = {
  name: 'build-review-pr',
  description: 'Build a requirement, loop reviewer<->fixer until the reviewer is satisfied, pause for a human on any DB schema change, then open a GitHub PR',
  whenToUse: 'When the user wants a feature/change implemented end-to-end: a builder implements it on a branch, a reviewer panel and a fixer iterate until there are no blocking findings, any database schema change is gated on human approval (agents never touch the DB), and a final agent pushes the branch and opens a GitHub PR.',
  phases: [
    { title: 'Build', detail: 'builder implements the requirement on a feature branch' },
    { title: 'Review', detail: 'reviewer panel checks the current diff each round' },
    { title: 'Fix', detail: 'fixer addresses blocking findings from the review', model: 'sonnet' },
    { title: 'PR', detail: 'push the branch and open the GitHub PR', model: 'haiku' },
  ],
}

// ============================================================================
// Args
//   requirement        (string, required) what to build
//   repoPath           (string, required) absolute path to the git repo
//   baseBranch         (string, default 'main')
//   branch             (string, optional) feature branch name; builder picks one if omitted
//   maxReviewRounds    (number, default 5) safety cap on review<->fix rounds
//   approvedDbChanges  (string[], default []) migration file paths the human has
//                      already approved/applied — used when resuming after a DB pause
//   skipPr             (boolean, default false) stop after review, don't open a PR
//   draftPr            (boolean, default false) open the PR as a draft
// ============================================================================

const requirement = args && args.requirement
const repoPath = args && args.repoPath
if (!requirement || !repoPath) {
  return {
    status: 'error',
    error: 'args.requirement (what to build) and args.repoPath (absolute path to the git repo) are both required.',
  }
}
const baseBranch = (args && args.baseBranch) || 'main'
const maxReviewRounds = (args && args.maxReviewRounds) || 5
const approvedDb = new Set((args && args.approvedDbChanges) || [])
const skipPr = !!(args && args.skipPr)
const draftPr = !!(args && args.draftPr)
const requestedBranch = (args && args.branch) || null

// ============================================================================
// Shared rules and schemas
// ============================================================================

const DB_RULE = `HARD RULE — DATABASE SCHEMA CHANGES (human in the loop, no exceptions):
You must NEVER execute a database schema change or run a migration yourself. Forbidden in every form: running DDL (CREATE/ALTER/DROP/TRUNCATE/RENAME) against any database, and any migration-executing command such as "prisma migrate dev/deploy", "prisma db push", "alembic upgrade", "rails db:migrate", "python manage.py migrate", "drizzle-kit push", "knex migrate:latest", "supabase db push", "flyway migrate", or equivalents. A human applies all schema changes.
If the work requires a schema change: write the migration file(s) into the repo following its existing conventions (do NOT execute them), and report every one in the dbSchemaChanges field of your structured output — description, migrationFile (repo-relative path), and the SQL / migration body. If the repo has no migration convention, create a plain .sql file under a sensible path (e.g. migrations/) and report it the same way.
Generated framework artifacts that merely DESCRIBE schema (model files, schema.prisma, generated migration files) are fine to create and commit — only APPLYING them to a database is forbidden.`

const DB_CHANGE_ITEM = {
  type: 'object',
  required: ['description', 'migrationFile'],
  properties: {
    description: { type: 'string', description: 'What this schema change does and why the feature needs it' },
    migrationFile: { type: 'string', description: 'Repo-relative path of the migration file written (not executed)' },
    sql: { type: 'string', description: 'The SQL or migration body, so a human can review it without opening the file' },
  },
}

const BUILD_SCHEMA = {
  type: 'object',
  required: ['branch', 'summary', 'filesChanged', 'dbSchemaChanges'],
  properties: {
    branch: { type: 'string', description: 'Name of the feature branch the work was committed on' },
    summary: { type: 'string', description: 'What was implemented and how' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    dbSchemaChanges: { type: 'array', items: DB_CHANGE_ITEM, description: 'Empty array if no schema changes were needed' },
    testResults: { type: 'string', description: 'What tests/linters were run and their outcome' },
    notes: { type: 'string', description: 'Assumptions made, follow-ups, anything the reviewer should know' },
  },
}

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['satisfied', 'issues'],
  properties: {
    satisfied: { type: 'boolean', description: 'true only if you found zero blocker/major issues from your lens' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'severity', 'description'],
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'] },
          description: { type: 'string', description: 'The defect and a concrete failure scenario' },
          suggestion: { type: 'string', description: 'How to fix it' },
        },
      },
    },
    overallAssessment: { type: 'string' },
  },
}

const FIX_SCHEMA = {
  type: 'object',
  required: ['summary', 'dbSchemaChanges'],
  properties: {
    summary: { type: 'string', description: 'What was fixed and how' },
    fixedIssues: { type: 'array', items: { type: 'string' }, description: 'One entry per issue addressed' },
    skippedIssues: { type: 'array', items: { type: 'string' }, description: 'Issues intentionally not fixed, each with a justification' },
    dbSchemaChanges: { type: 'array', items: DB_CHANGE_ITEM, description: 'NEW schema changes introduced by the fixes; empty array if none' },
  },
}

const PR_SCHEMA = {
  type: 'object',
  required: ['created'],
  properties: {
    created: { type: 'boolean' },
    prUrl: { type: 'string' },
    title: { type: 'string' },
    error: { type: 'string', description: 'If created=false: what failed (auth, no remote, etc.) and exact manual commands the user can run instead' },
  },
}

// ============================================================================
// Helpers
// ============================================================================

const allDbChanges = []

function trackDbChanges(list) {
  const fresh = []
  for (const c of list || []) {
    if (!allDbChanges.some((seen) => seen.migrationFile === c.migrationFile)) allDbChanges.push(c)
    if (!approvedDb.has(c.migrationFile)) fresh.push(c)
  }
  return fresh
}

function awaitingDbApproval(pending, branch, when) {
  log(`PAUSED: ${pending.length} DB schema change(s) from ${when} need human approval before continuing.`)
  return {
    status: 'awaiting_db_approval',
    branch,
    pausedAfter: when,
    pendingDbChanges: pending,
    instructionsForOrchestrator:
      'STOP and hand control to the human. Show them each pending schema change (description, migrationFile, sql) and ask them to review and apply the changes to their database themselves (or explicitly authorize them). Agents must not apply these. Once the human confirms, re-invoke this workflow with resumeFromRunId set to this run id and the SAME args plus approvedDbChanges: [' +
      pending.map((c) => JSON.stringify(c.migrationFile)).join(', ') +
      '] (appended to any previously approved paths). All completed agents replay from cache; the run continues where it paused.',
  }
}

function issuesBlock(issues) {
  return issues
    .map(
      (i, n) =>
        `${n + 1}. [${i.severity}] ${i.file}${i.line ? ':' + i.line : ''} — ${i.description}${i.suggestion ? '\n   Suggested fix: ' + i.suggestion : ''}`
    )
    .join('\n')
}

// ============================================================================
// Phase 1 — Build
// ============================================================================

phase('Build')
log(`Builder implementing: ${requirement.slice(0, 120)}${requirement.length > 120 ? '…' : ''}`)

const buildPrompt = `You are the BUILDER agent in a build → review → fix → PR pipeline.

Repository: ${repoPath} — do ALL work inside this directory (cd there first; every git/file operation happens in this repo).
Base branch: ${baseBranch}

REQUIREMENT TO IMPLEMENT:
${requirement}

Steps:
1. Study the codebase first: how is it structured, what conventions, frameworks, and test setup does it use? Implement the requirement the way THIS repo does things, not generically.
2. Make sure the working tree is clean enough to branch (stash nothing silently — if there are unrelated uncommitted changes, leave them alone and still create your branch). Create a feature branch off ${baseBranch}${requestedBranch ? ` named exactly "${requestedBranch}"` : ' with a short kebab-case name like feat/<slug> derived from the requirement (if the name is taken, append -2, -3, …)'} and do all work on it.
3. Implement the requirement completely. Add or update tests if the repo has a test suite; follow existing patterns for structure, naming, and error handling.
4. Run the repo's test suite / linter if one exists and is reasonably fast; fix anything your change broke. Record what you ran and the outcome in testResults.
5. ${DB_RULE}
6. Commit your work on the feature branch with clear commit message(s). Do NOT push and do NOT open a PR — a later agent does that.

Your structured output: the branch name, a summary of what you built, the list of changed files, dbSchemaChanges (empty array if none), testResults, and notes for the reviewer.`

const build = await agent(buildPrompt, { label: 'builder', phase: 'Build', effort: 'high', schema: BUILD_SCHEMA })
if (!build) {
  return { status: 'error', error: 'Builder agent failed or was skipped; nothing was built.' }
}
const branch = build.branch
log(`Build done on branch ${branch}: ${build.filesChanged.length} file(s) changed.`)

{
  const pending = trackDbChanges(build.dbSchemaChanges)
  if (pending.length) return awaitingDbApproval(pending, branch, 'the initial build')
}

// ============================================================================
// Phase 2+3 — Review <-> Fix loop (runs until the reviewer panel is satisfied)
// ============================================================================

// Model tiering: spend where mistakes escape the pipeline, economize where the
// loop catches them. The correctness lens is the final quality gate (what it
// misses, ships) so it stays on a big model — it must be at least the builder's
// tier or it rubber-stamps the builder's blind spots. Safety/quality lenses are
// mechanical enough for sonnet; the fixer's work is re-verified next round so
// sonnet is safe there; PR creation is pure mechanics (haiku). The builder
// inherits the session model.
const LENSES = [
  {
    key: 'correctness',
    model: 'opus',
    effort: 'high',
    focus:
      'CORRECTNESS AND REQUIREMENT FIT. Does the diff fully implement the requirement? Hunt for real bugs: broken edge cases, wrong logic, unhandled errors, race conditions, regressions to existing behavior. Run the test suite if one exists and treat failures caused by this change as blockers. For every issue give a concrete failure scenario (inputs/state → wrong result).',
  },
  {
    key: 'safety',
    model: 'sonnet',
    effort: 'high',
    focus:
      'SECURITY AND DATABASE SAFETY. Look for injection, missing authorization, secrets in code, unsafe input handling. CRITICALLY: verify no database migration was EXECUTED by the previous agents — check for evidence like updated migration lock/state files, and confirm every schema change exists only as an unapplied migration file. Any executed migration, or any schema change NOT declared as a migration file, is a blocker.',
  },
  {
    key: 'quality',
    model: 'sonnet',
    effort: 'medium',
    focus:
      'CODE QUALITY. Does the change match the repo\'s existing conventions and style? Flag dead code, needless complexity, duplication of existing utilities, missing test coverage for the new behavior. Reserve blocker/major for things that genuinely should not merge; style nits are minor/nit.',
  },
]

function reviewPrompt(lens, round, prevBlocking, prevFix) {
  const followUp =
    round > 1 && prevFix
      ? `

This is review round ${round}. Last round the following blocking issues were reported:
${issuesBlock(prevBlocking)}

The fixer claims: ${prevFix.summary}
Fixed: ${(prevFix.fixedIssues || []).join('; ') || '(none listed)'}
Skipped (with justification): ${(prevFix.skippedIssues || []).join('; ') || '(none)'}

VERIFY each previously-reported issue is actually resolved in the current code — do not take the fixer's word for it. Re-report anything still broken, judge the skip justifications on their merits, and also check the fixes didn't introduce new problems.`
      : ''

  return `You are a CODE REVIEWER agent in a build → review → fix → PR pipeline. You review; you never modify files (running tests/linters read-only style is fine).

Repository: ${repoPath} (cd there first). The change under review is branch "${branch}" versus base "${baseBranch}".
Inspect it with: git -C ${repoPath} diff ${baseBranch}...${branch}
Read the full files around the diff — do not review hunks in isolation.

The requirement this change is meant to implement:
${requirement}

Builder's summary: ${build.summary}
Builder's notes: ${build.notes || '(none)'}
Declared DB schema changes (a human applies these separately; their presence as unapplied migration files is expected and correct): ${(build.dbSchemaChanges || []).map((c) => c.migrationFile).join(', ') || 'none'}

YOUR LENS: ${lens.focus}${followUp}

Severity meanings — be honest, not lenient and not theatrical:
- blocker: must not merge (real bug, requirement not met, security hole, executed DB migration, failing tests)
- major: should be fixed before merge
- minor / nit: worth noting, does NOT block the merge and will NOT be sent to the fixer

Set satisfied=true only if you found zero blocker/major issues from your lens. Only report issues within your lens.`
}

function fixPrompt(blocking, round, reviewerNotes) {
  return `You are the FIXER agent in a build → review → fix → PR pipeline (fix round ${round}).

Repository: ${repoPath} (cd there first). Work on branch "${branch}" (check it out if needed); the base branch is "${baseBranch}".

The original requirement:
${requirement}

A reviewer panel found these BLOCKING issues in the current diff (${baseBranch}...${branch}):
${issuesBlock(blocking)}

Reviewer overall assessments:
${reviewerNotes}

Steps:
1. Read the code around every issue and fix each one properly — address the root cause, not the symptom. If you are convinced an issue is a false positive, you may skip it, but you must justify the skip concretely in skippedIssues (the reviewers will judge your justification next round).
2. Keep fixes surgical: do not refactor beyond what the issues require.
3. Re-run the relevant tests/linter to confirm the fixes hold.
4. ${DB_RULE}
5. Commit the fixes on branch "${branch}". Do NOT push, do NOT open a PR.

Your structured output: summary of the fixes, fixedIssues, skippedIssues (each with justification), and dbSchemaChanges for any NEW schema change the fixes required (empty array if none).`
}

let round = 0
let satisfied = false
let lastBlocking = []
let lastFix = null
let lastReviews = []
const roundHistory = []

while (round < maxReviewRounds && !satisfied) {
  round += 1
  log(`Review round ${round}/${maxReviewRounds}…`)

  // Barrier is intentional: the fixer needs the merged findings of the whole panel.
  const reviews = (
    await parallel(
      LENSES.map((l) => () =>
        agent(reviewPrompt(l, round, lastBlocking, lastFix), {
          label: `review:${l.key} r${round}`,
          phase: 'Review',
          model: l.model,
          effort: l.effort,
          schema: REVIEW_SCHEMA,
        })
      )
    )
  ).filter(Boolean)

  if (!reviews.length) {
    return { status: 'error', error: `All reviewer agents failed in round ${round}.`, branch }
  }
  if (reviews.length < LENSES.length) {
    log(`Warning: only ${reviews.length}/${LENSES.length} reviewers returned in round ${round}; proceeding with their findings.`)
  }

  lastReviews = reviews
  const issues = reviews.flatMap((r) => r.issues || [])
  const blocking = issues.filter((i) => i.severity === 'blocker' || i.severity === 'major')
  roundHistory.push({ round, blockingIssues: blocking.length, totalIssues: issues.length })
  satisfied = blocking.length === 0

  if (satisfied) {
    log(`Round ${round}: reviewer panel satisfied (${issues.length} non-blocking note(s) remain).`)
    lastBlocking = []
    break
  }

  log(`Round ${round}: ${blocking.length} blocking issue(s) → fixer.`)
  const reviewerNotes = reviews.map((r) => r.overallAssessment || '').filter(Boolean).join('\n---\n') || '(none)'
  const fix = await agent(fixPrompt(blocking, round, reviewerNotes), {
    label: `fixer r${round}`,
    phase: 'Fix',
    model: 'sonnet',
    effort: 'high',
    schema: FIX_SCHEMA,
  })
  if (!fix) {
    return { status: 'error', error: `Fixer agent failed in round ${round}.`, branch, unresolvedBlockingIssues: blocking }
  }
  lastFix = fix
  lastBlocking = blocking

  const pending = trackDbChanges(fix.dbSchemaChanges)
  if (pending.length) return awaitingDbApproval(pending, branch, `fix round ${round}`)
}

if (!satisfied) {
  return {
    status: 'review_not_satisfied',
    branch,
    roundsRun: round,
    unresolvedBlockingIssues: lastBlocking,
    reviewHistory: roundHistory,
    note: `Hit the maxReviewRounds cap (${maxReviewRounds}) with blocking issues still open. No PR was created. A human should look at the unresolved issues — then either fix manually, or re-run with a higher maxReviewRounds / a sharper requirement.`,
  }
}

const nonBlockingNotes = lastReviews.flatMap((r) => r.issues || []).filter((i) => i.severity === 'minor' || i.severity === 'nit')

if (skipPr) {
  return {
    status: 'reviewed_no_pr',
    branch,
    buildSummary: build.summary,
    reviewHistory: roundHistory,
    nonBlockingNotes,
    dbSchemaChanges: allDbChanges,
    note: 'skipPr was set — branch is committed locally and review-clean, but not pushed.',
  }
}

// ============================================================================
// Phase 4 — PR
// ============================================================================

phase('PR')
log('Reviewer satisfied — creating the pull request.')

const dbSection = allDbChanges.length
  ? `

The PR body MUST contain a clearly-titled section "## Database schema changes (apply manually)" listing each of these migrations — a human applies them, they are never run by automation:
${allDbChanges.map((c) => `- ${c.migrationFile}: ${c.description}`).join('\n')}`
  : ''

const prPrompt = `You are the PR agent in a build → review → fix → PR pipeline. The change has passed review.

Repository: ${repoPath} (cd there first). Feature branch: "${branch}". Base branch: "${baseBranch}".

Steps:
1. Confirm the branch has committed work (git log ${baseBranch}..${branch}) and the working tree is clean; commit any straggler changes on the branch if the pipeline's agents left them uncommitted.
2. Check gh auth status and that an origin remote exists. If either is missing, do NOT improvise credentials — return created=false with an error explaining exactly what the user must run manually (e.g. gh auth login, git remote add, then the exact git push + gh pr create commands).
3. Push the branch: git push -u origin ${branch}
4. Create the PR${draftPr ? ' as a DRAFT (--draft)' : ''} with: gh pr create --base ${baseBranch} --head ${branch}
   - Title: concise, imperative, derived from the requirement.
   - Body: what & why (from the summary below), how it was validated (tests + ${round} review round(s) by an automated reviewer panel), and any reviewer notes worth surfacing.${dbSection}
   - End the body with: 🤖 Generated with [Claude Code](https://claude.com/claude-code)

The requirement: ${requirement}
Build summary: ${build.summary}
Test results: ${build.testResults || '(not recorded)'}
Non-blocking review notes: ${nonBlockingNotes.map((i) => `${i.file}: ${i.description}`).join('; ') || 'none'}

Return created=true with the prUrl on success; created=false with a precise error and manual fallback commands otherwise.`

const pr = await agent(prPrompt, { label: 'pr-creator', phase: 'PR', model: 'haiku', effort: 'low', schema: PR_SCHEMA })

return {
  status: pr && pr.created ? 'pr_created' : 'pr_failed',
  prUrl: pr && pr.prUrl,
  prError: pr ? pr.error : 'PR agent failed to run.',
  branch,
  buildSummary: build.summary,
  reviewHistory: roundHistory,
  nonBlockingNotes,
  dbSchemaChanges: allDbChanges,
  humanActionNeeded: allDbChanges.length
    ? 'Remember: the DB schema changes listed above must be applied to the database by a human — the agents only wrote the migration files.'
    : null,
}
