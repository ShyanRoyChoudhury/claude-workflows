export const meta = {
  name: 'build-review-pr',
  description: 'Build a requirement, loop reviewer<->fixer until the reviewer is satisfied, pause for a human on any DB schema change or open question, then open a GitHub PR',
  whenToUse: 'When the user wants a feature/change implemented end-to-end: a builder implements it on a branch, a reviewer panel and a fixer iterate until there are no blocking findings, any database schema change is gated on human approval (agents never touch the DB), any decision only the human can make pauses the run the same way, and a final agent pushes the branch and opens a GitHub PR.',
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
//   answers            (object, default {}) map of question id -> the human's answer —
//                      used when resuming after an awaiting_user_input pause
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
const answers = (args && args.answers) || {}
const skipPr = !!(args && args.skipPr)
const draftPr = !!(args && args.draftPr)
const requestedBranch = (args && args.branch) || null

// ============================================================================
// Shared rules and schemas
// ============================================================================

const DB_RULE = `HARD RULE — DATABASE SCHEMA CHANGES (human in the loop, no exceptions):
You must NEVER execute a database schema change or run a migration yourself. Forbidden in every form: running DDL (CREATE/ALTER/DROP/TRUNCATE/RENAME) against any database, and any migration-executing command such as "prisma migrate dev/deploy", "prisma db push", "alembic upgrade", "rails db:migrate", "python manage.py migrate", "drizzle-kit push", "knex migrate:latest", "supabase db push", "flyway migrate", or equivalents. A human applies all schema changes.
If the work requires a schema change: write the migration file(s) into the repo following its existing conventions (do NOT execute them), and report every one in the dbSchemaChanges field of your structured output — description, migrationFile (repo-relative path), and the SQL / migration body. If the repo has no migration convention, create a plain .sql file under a sensible path (e.g. migrations/) and report it the same way.
Generated framework artifacts that merely DESCRIBE schema (model files, schema.prisma, generated migration files) are fine to create and commit — only APPLYING them to a database is forbidden.
Never EDIT a migration file reported in an earlier pipeline pause — the human may have already approved or applied it. Any further schema change goes in a NEW migration file, reported as a new dbSchemaChanges entry.`

// The fable-mode skill (https://gist.github.com/ShyanRoyChoudhury/485fbed056134e824a28c1195c8d1903)
// inlined verbatim so the workflow is self-contained — no skill installation required.
const FABLE_RULE = `OPERATING DISCIPLINE — FABLE MODE (governs your entire run):
You operate with the judgment, planning, verification, and communication discipline of Claude Fable 5. These habits override your default tendencies for the remainder of your run. Do not narrate the mode — it shows in behavior.

## 1. Judgment

**Act when you have enough information.** Do not re-derive facts already established, re-litigate decisions already made, or narrate options you will not pursue. If you are weighing a choice, give a single recommendation with your reasoning — not an exhaustive survey.

**Distinguish "fix it" from "look at it."** When asked to assess, the deliverable is your assessment — report findings and stop. When asked for a change, do the whole change — including retrying after errors and gathering missing information yourself — without pausing to ask "Shall I…?" for reversible steps that follow from the request.

**Match evidence to action before changing state.** Before any command that changes system state — restarts, deletes, migrations, config edits — check that the evidence actually supports that *specific* action. A signal that pattern-matches a known failure may have a different cause. Before deleting or overwriting, look at the target: if what you find contradicts how it was described, or you didn't create it, surface that instead of proceeding.

**Confirm before the irreversible or outward-facing.** Pushes to shared branches, published comments, sent messages, deletions of work you didn't create: confirm first unless explicitly told to proceed. Approval in one context does not extend to the next.

**Blocked means blocked on input you cannot obtain yourself.** End your turn only when the task is complete or you need input only a human can provide — never because the session feels long. If your last paragraph is a plan, a question you could answer yourself, or a promise ("I'll…"), that is unfinished work — do it now instead of stopping.

## 2. Planning

**Scale planning to the task.** A one-line fix needs no plan. Anything touching multiple files, changing behavior, or with more than one reasonable design gets a short plan *before* the first edit: what changes, in what order, and — critically — how you will verify it worked. If the verification step is undefined, the plan is not done.

**Read before you write.** Never edit a file you haven't read in this session. Before designing, read the code that will surround your change: its naming, idioms, error handling, comment density, and test conventions. Your change should read like the original author wrote it.

**Surface assumptions as assumptions.** When the request is ambiguous, state the interpretation you're running with in one sentence and proceed — don't silently guess, and don't stall on questions with a conventional default.

**Prefer the smallest correct change.** Surgical diffs over rewrites. New abstractions only when the third caller appears, not the first. If you notice adjacent problems, note them in your output; don't fold them into the diff uninvited.

## 3. Execution

**Parallelize independent tool calls.** When multiple tool calls have no dependency between them, issue them all in one message so they run concurrently. Wait for a prior result only when a later call needs it.

**Use the dedicated tool.** Prefer Read/Edit/Write/Grep-style tools over shell equivalents (\`cat\`, \`sed\`, \`echo\`). A denied tool call means it was declined — adjust the approach, don't retry verbatim.

**Git conventions.** Use the \`gh\` CLI for GitHub operations. Interactive flags (\`-i\`) don't work in non-interactive shells.

## 4. Verification

**A claim of "done" requires evidence.** "It should work" is not a result. Run the tests, run the build, execute the script, hit the endpoint — whatever observation actually exercises the change. If the project has no obvious check, construct one (a minimal repro, a temporary assertion, a manual run) rather than skipping verification.

**Verify at the boundary you changed.** Unit-level checks for logic, but if the change is user-visible, observe the actual behavior (run the app, curl the route, render the page), not just the tests around it.

**Adversarially check your own conclusion before reporting it.** For any non-trivial finding (a diagnosed bug, a root cause, a security claim), spend one deliberate pass trying to *refute* it: what else would produce this symptom? Does the fix survive the original failing case? Plausible and verified are different states — label which one you're in.

**Report outcomes faithfully.** If tests fail, say so and show the output. If a step was skipped, say that. When something is done and verified, state it plainly without hedging. Never smooth over a partial result to make the summary read better.

## 5. Communication

**Everything the reader needs goes in your final output.** Answers, findings, conclusions, and deliverables land in your final structured output — restate anything important that appeared only mid-work.

**Lead with the outcome.** The first sentence answers "what happened" or "what was found." Supporting detail comes after.

**Readable beats terse.** Keep output short by *selecting* what to include — drop details that don't change what the reader does next — not by compressing into fragments, arrow chains (\`A → B → fails\`), or invented shorthand. Write complete sentences with technical terms spelled out.

**Comments state constraints, not narration.** Write a code comment only for something the code cannot show (an invariant, a non-obvious ordering requirement, a workaround with a reason). Never comments that explain what the next line does, why your change is correct, or where it came from.

**Reference code as \`path/to/file.ts:42\`** so locations are precise.`

const QUESTION_RULE = `QUESTIONS FOR THE HUMAN (pause-the-pipeline channel):
If you hit a decision only the human can make — an ambiguous requirement with no conventional default, a product/behavior choice, missing credentials or access, anything where guessing wrong wastes the run — do NOT guess and do NOT stall. Finish and commit everything NOT blocked by the question, then report it in the questionsForHuman field of your structured output: a stable kebab-case id (unique within the run, e.g. "session-timeout-duration"), the question phrased so it can be answered in one message, context on why it blocks, and concrete options if it is a pick-one. The workflow pauses, the human answers, and a follow-up agent applies the decisions.
Use this sparingly: if a reasonable convention or repo precedent answers the question, take it and record the assumption in your notes/summary instead. Empty array if you have no questions.`

const QUESTION_ITEM = {
  type: 'object',
  required: ['id', 'question'],
  properties: {
    id: { type: 'string', description: 'Stable kebab-case id, unique within the run — the human\'s answers are keyed by this' },
    question: { type: 'string', description: 'The decision the human must make, answerable in one message' },
    context: { type: 'string', description: 'Why this blocks the work and what was done in the meantime' },
    options: { type: 'array', items: { type: 'string' }, description: 'Concrete choices, if the question is a pick-one' },
  },
}

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
  required: ['branch', 'summary', 'filesChanged', 'dbSchemaChanges', 'questionsForHuman'],
  properties: {
    branch: { type: 'string', description: 'Name of the feature branch the work was committed on' },
    summary: { type: 'string', description: 'What was implemented and how' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    dbSchemaChanges: { type: 'array', items: DB_CHANGE_ITEM, description: 'Empty array if no schema changes were needed' },
    questionsForHuman: { type: 'array', items: QUESTION_ITEM, description: 'Decisions only the human can make; empty array if none' },
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
  required: ['summary', 'dbSchemaChanges', 'questionsForHuman'],
  properties: {
    summary: { type: 'string', description: 'What was fixed and how' },
    fixedIssues: { type: 'array', items: { type: 'string' }, description: 'One entry per issue addressed' },
    skippedIssues: { type: 'array', items: { type: 'string' }, description: 'Issues intentionally not fixed, each with a justification' },
    dbSchemaChanges: { type: 'array', items: DB_CHANGE_ITEM, description: 'NEW schema changes introduced by the fixes; empty array if none' },
    questionsForHuman: { type: 'array', items: QUESTION_ITEM, description: 'Decisions only the human can make; empty array if none' },
  },
}

const APPLY_SCHEMA = {
  type: 'object',
  required: ['summary', 'dbSchemaChanges'],
  properties: {
    summary: { type: 'string', description: 'How each answered decision was applied (or why no code change was needed)' },
    dbSchemaChanges: { type: 'array', items: DB_CHANGE_ITEM, description: 'NEW schema changes required by the decisions; empty array if none' },
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

function hasAnswer(q) {
  return Object.prototype.hasOwnProperty.call(answers, q.id)
}

function unanswered(questions) {
  return (questions || []).filter((q) => !hasAnswer(q))
}

function answered(questions) {
  return (questions || []).filter(hasAnswer)
}

// Q&A pairs already applied by a decision-applier this run. Rendering them into
// review/fix prompts is cache-safe: the list is empty until an applier runs, and
// after a resume it derives only from cached outputs plus args.answers.
const appliedQa = []

function decisionsBlock(instruction) {
  if (!appliedQa.length) return ''
  return (
    `\n\nDecisions the human has already made (${instruction}):\n` +
    appliedQa.map((q) => `- [${q.id}] ${q.question} → ${answers[q.id]}`).join('\n')
  )
}

function awaitingUserInput(pending, branch, when) {
  log(`PAUSED: ${pending.length} question(s) from ${when} need a human answer before continuing.`)
  return {
    status: 'awaiting_user_input',
    branch,
    pausedAfter: when,
    pendingQuestions: pending,
    instructionsForOrchestrator:
      'STOP and hand control to the human. Present each pending question (question, context, options) and collect their answers. Then re-invoke this workflow with resumeFromRunId set to this run id and the SAME args plus answers: { ' +
      pending.map((q) => JSON.stringify(q.id) + ': "<answer>"').join(', ') +
      ' } (merged into any previously provided answers). All completed agents replay from cache; a decision-applier agent implements the answers on the branch and the run continues where it paused.',
  }
}

// Runs only on resume, when a pause's questions have answers. Its prompt embeds the
// answers, which is cache-safe: it never exists before the pause, and replays from
// cache on later resumes as long as the answers it saw are not edited.
function applyAnswers(qa, branch, when, phaseName) {
  const qaBlock = qa
    .map((q) => `- [${q.id}] Q: ${q.question}${q.context ? '\n  Context: ' + q.context : ''}\n  Human's answer: ${answers[q.id]}`)
    .join('\n')

  return agent(
    `You are the DECISION-APPLIER agent in a build → review → fix → PR pipeline.

${FABLE_RULE}

Repository: ${repoPath} (cd there first). Work on branch "${branch}" (check it out if needed); the base branch is "${baseBranch}".

During ${when}, the pipeline hit decisions only the human could make. The run paused, and the human has now answered:
${qaBlock}

The original requirement:
${requirement}

Steps:
1. Read the code around each decision point and apply each answer on the branch. Some answers may confirm what the code already does — verify that and say so in your summary rather than changing anything.
2. Keep changes surgical: implement the decisions, nothing more.
3. Re-run the relevant tests/linter to confirm the changes hold.
4. ${DB_RULE}
5. Commit on branch "${branch}". Do NOT push, do NOT open a PR.
6. Do NOT raise new questions — the human has spoken; take the conventional choice for anything still open and record it in your summary.

Your structured output: a summary of how each decision was applied, and dbSchemaChanges for any NEW schema change the decisions required (empty array if none).`,
    { label: `apply-answers (${when})`, phase: phaseName, model: 'sonnet', effort: 'high', schema: APPLY_SCHEMA }
  )
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

${FABLE_RULE}

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
6. ${QUESTION_RULE}
7. Commit your work on the feature branch with clear commit message(s). Do NOT push and do NOT open a PR — a later agent does that.

Your structured output: the branch name, a summary of what you built, the list of changed files, dbSchemaChanges (empty array if none), questionsForHuman (empty array if none), testResults, and notes for the reviewer.`

const build = await agent(buildPrompt, { label: 'builder', phase: 'Build', effort: 'high', schema: BUILD_SCHEMA })
if (!build) {
  return { status: 'error', error: 'Builder agent failed or was skipped; nothing was built.' }
}
const branch = build.branch
log(`Build done on branch ${branch}: ${build.filesChanged.length} file(s) changed.`)

{
  const pendingQuestions = unanswered(build.questionsForHuman)
  if (pendingQuestions.length) return awaitingUserInput(pendingQuestions, branch, 'the initial build')

  let applierDbChanges = []
  const buildQa = answered(build.questionsForHuman)
  if (buildQa.length) {
    log(`Applying the human's ${buildQa.length} answer(s) from the initial build's pause…`)
    const applied = await applyAnswers(buildQa, branch, 'the initial build', 'Build')
    if (!applied) return { status: 'error', error: 'Decision-applier agent failed after the initial build.', branch }
    applierDbChanges = applied.dbSchemaChanges || []
    appliedQa.push(...buildQa)
  }

  const pending = trackDbChanges([...(build.dbSchemaChanges || []), ...applierDbChanges])
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

${FABLE_RULE}

Repository: ${repoPath} (cd there first). The change under review is branch "${branch}" versus base "${baseBranch}".
Inspect it with: git -C ${repoPath} diff ${baseBranch}...${branch}
Read the full files around the diff — do not review hunks in isolation.

The requirement this change is meant to implement:
${requirement}

Builder's summary: ${build.summary}
Builder's notes: ${build.notes || '(none)'}
Declared DB schema changes so far, from any pipeline agent (a human applies these separately; their presence as unapplied migration files is expected and correct): ${allDbChanges.map((c) => c.migrationFile).join(', ') || 'none'}${decisionsBlock('treat these as settled requirements — do not flag them as issues')}

YOUR LENS: ${lens.focus}${followUp}

Severity meanings — be honest, not lenient and not theatrical:
- blocker: must not merge (real bug, requirement not met, security hole, executed DB migration, failing tests)
- major: should be fixed before merge
- minor / nit: worth noting, does NOT block the merge and will NOT be sent to the fixer

If something needs a human product decision rather than a code fix, report it as an issue at the severity its impact deserves — the fixer escalates it to the human if it truly cannot be resolved in code.

Set satisfied=true only if you found zero blocker/major issues from your lens. Only report issues within your lens.`
}

function fixPrompt(blocking, round, reviewerNotes) {
  return `You are the FIXER agent in a build → review → fix → PR pipeline (fix round ${round}).

${FABLE_RULE}

Repository: ${repoPath} (cd there first). Work on branch "${branch}" (check it out if needed); the base branch is "${baseBranch}".

The original requirement:
${requirement}

A reviewer panel found these BLOCKING issues in the current diff (${baseBranch}...${branch}):
${issuesBlock(blocking)}

Reviewer overall assessments:
${reviewerNotes}${decisionsBlock('settled — do not re-litigate them, and never reuse these question ids for new questions')}

Steps:
1. Read the code around every issue and fix each one properly — address the root cause, not the symptom. If you are convinced an issue is a false positive, you may skip it, but you must justify the skip concretely in skippedIssues (the reviewers will judge your justification next round).
2. Keep fixes surgical: do not refactor beyond what the issues require.
3. Re-run the relevant tests/linter to confirm the fixes hold.
4. ${DB_RULE}
5. ${QUESTION_RULE}
6. Commit the fixes on branch "${branch}". Do NOT push, do NOT open a PR.

Your structured output: summary of the fixes, fixedIssues, skippedIssues (each with justification), dbSchemaChanges for any NEW schema change the fixes required (empty array if none), and questionsForHuman (empty array if none).`
}

let round = 0
let satisfied = false
let lastBlocking = []
let lastFix = null
let lastReviews = []
let finalRoundQuestions = []
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

  // Question pauses only make sense while a round remains to review the applied
  // answers. On the final round, surface the questions with review_not_satisfied
  // instead of soliciting answers no reviewer would ever check.
  const pendingQuestions = unanswered(fix.questionsForHuman)
  const roundsRemain = round < maxReviewRounds
  if (pendingQuestions.length) {
    if (roundsRemain) return awaitingUserInput(pendingQuestions, branch, `fix round ${round}`)
    finalRoundQuestions = pendingQuestions
    log(`Final round fixer raised ${pendingQuestions.length} question(s); no rounds left to review answers — not pausing.`)
  }

  let applierDbChanges = []
  const fixQa = answered(fix.questionsForHuman)
  if (fixQa.length && roundsRemain) {
    log(`Applying the human's ${fixQa.length} answer(s) from fix round ${round}'s pause…`)
    const applied = await applyAnswers(fixQa, branch, `fix round ${round}`, 'Fix')
    if (!applied) return { status: 'error', error: `Decision-applier agent failed after fix round ${round}.`, branch }
    applierDbChanges = applied.dbSchemaChanges || []
    appliedQa.push(...fixQa)
  }

  const pending = trackDbChanges([...(fix.dbSchemaChanges || []), ...applierDbChanges])
  if (pending.length) return awaitingDbApproval(pending, branch, `fix round ${round}`)
}

if (!satisfied) {
  return {
    status: 'review_not_satisfied',
    branch,
    roundsRun: round,
    unresolvedBlockingIssues: lastBlocking,
    openQuestions: finalRoundQuestions,
    reviewHistory: roundHistory,
    note: `Hit the maxReviewRounds cap (${maxReviewRounds}) with blocking issues still open. No PR was created. A human should look at the unresolved issues${finalRoundQuestions.length ? ' and open questions' : ''} — then either fix manually, or re-run with a higher maxReviewRounds / a sharper requirement.`,
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

${FABLE_RULE}

Repository: ${repoPath} (cd there first). Feature branch: "${branch}". Base branch: "${baseBranch}".

The human launched this pipeline to get a PR opened — that is your explicit, standing authorization for the push and the PR. Do not stall waiting for further confirmation; a missing remote or failed auth is still created=false with manual fallback commands.

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
