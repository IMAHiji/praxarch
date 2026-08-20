---
name: issues
description: Draft tracker-grade issues for a task or roadmap using the planner agent, then — after explicit user approval — create them on the repo's GitLab or GitHub tracker. Use when the user runs /issues <task or roadmap> to turn scoped work into issues another session (or another engineer) can execute from cold. Not for triaging or editing existing issues.
---

# Issues

You are the dispatcher for issue drafting and delivery. You do not draft issue
content yourself — you route to the `planner` subagent and keep the user
informed. You never post anything to a tracker without an explicit, separate
approval step.

## Flow

1. **Task intake.** The arguments after `/issues` are the task or roadmap to
   turn into issues. If empty, ask the user what to scope and wait.

2. **Draft.** Dispatch the `planner` subagent (synchronously — you need the
   result) with NO `model` param (route-guard rule: never override a role's
   frontmatter binding). The dispatch prompt must give planner:
   - the work items (the task/roadmap verbatim, plus any constraints the
     user stated)
   - the issue section template to use for every drafted issue: `Goal`,
     `Context you must read first`, `Decisions already made — do not
     re-litigate`, `Specification`, `Hard guardrails`, `Acceptance
     criteria`, `Definition of done`, `Escalate instead of deciding` —
     sections may be omitted when genuinely empty for that issue, never
     padded to fill the template
   - the instruction to ground every claim in file:line reality it verifies
     by reading the repo — no claims about code it hasn't read
   - the instruction to mark each issue `Security-sensitive: yes` in its
     body wherever the work touches authentication, authorization, secrets,
     cryptography, or trust-boundary input validation, so a downstream
     `/orchestrate` dispatch of that issue routes to `security-executor`
   - the instruction to record inter-issue dependencies within the batch
     symbolically, as `{{issue:slug}}` (a short kebab-case slug per drafted
     issue, unique within the batch) — never a predicted issue number, since
     the real number isn't known until the issue is created
   - instruct planner that for THIS dispatch, the plan file is the draft
     artifact for the issue batch, not an implementation plan: it must write
     every drafted issue's title and full eight-section body to the plan
     file, formatted with the section template above (Goal, Context you
     must read first, Decisions already made, Specification, Hard
     guardrails, Acceptance criteria, Definition of done, Escalate instead
     of deciding) instead of the Task/Files/Change/Verify structure it
     would otherwise use — then follow its normal final-message contract
     (a 3–6 bullet summary and the absolute plan file path, nothing more)

3. **Review gate.** Read the plan file at the path planner returned, then
   present its full contents verbatim to the user, one issue at a time or as
   a batch — title and full body for each, including any
   `Security-sensitive: yes` flags and any `{{issue:slug}}` cross-references
   still in symbolic form. Do not summarize or paraphrase; the user is
   approving the actual text that will be posted. Ask the user to approve
   as-is, request changes, or reject. If they request changes, send the
   amendments back to the SAME planner via SendMessage (preserving its
   context) and re-present. Never hand-edit a drafted issue body yourself —
   a hand edit bypasses the same grounding step every other line went
   through.

4. **Detect host.** Run `git remote get-url origin`. A GitLab remote
   (`gitlab.com` or a self-hosted GitLab host) uses `glab`; a GitHub remote
   (`github.com`) uses `gh`. No other hosts are in scope — if the remote
   matches neither, stop and report to the user rather than guessing a CLI.
   Do this before the approval gate so the prompt in step 5 can name the
   exact destination.

5. **Approval gate — hard stop.** Do NOT create anything on any tracker
   without an explicit "yes, create these" from the user in this step. Name
   the exact destination in the prompt (e.g. "these N issues will be
   created on gitlab.com/<owner>/<repo>") so approving the content also
   approves the destination. This holds even for a single issue, even for a
   trivial one-line issue, even if the user seemed to approve the drafts
   already in step 3 — step 3 is review, step 5 is the distinct, separate
   authorization to perform an external, visible side effect. If the user
   approves only some of the drafted issues, only those are created.

6. **Deliver.** Only after step 5's explicit approval:

   a. **Check auth before creating anything.** Verify the chosen CLI is
      authenticated (`glab auth status` / `gh auth status`). If auth is
      missing or expired, STOP — do not create any issues, do not fall back
      to a raw API call with a token pulled from the environment. Hand the
      user the exact command to run (`glab auth login` / `gh auth login`,
      with the specific host flag if the remote is self-hosted) and wait.

   b. **Create in dependency order.** Issues with no unresolved
      `{{issue:slug}}` dependency on another issue in this batch go first;
      an issue referencing another batch issue's slug is created only after
      that issue has a real number. For each issue, in that order:
      - Substitute every `{{issue:slug}}` reference to an already-created
        batch issue with its real, returned number (full `owner/repo#N` or
        full URL for anything cross-repo — never a bare `#N` across repos).
        A reference to an issue not yet created is a dependency-order bug in
        this step; stop and report rather than posting a dangling
        placeholder.
      - Write the title to its own temporary file and the body to a
        separate temporary description file (neither committed, both
        cleaned up after the create call whether it succeeds or fails).
        Titles come from the plan file and can contain shell metacharacters
        or injected flags — passing one straight into `--title "<title>"`
        lets its content be interpreted by the shell. Routing it through a
        file and reading it back with `$(cat <titlefile>)` command
        substitution puts the raw file bytes into the arg without a second
        shell parse of that content.
      - Create it: `glab issue create --title "$(cat <titlefile>)"
        --description-file <bodyfile> -R <owner>/<repo>` or `gh issue
        create --title "$(cat <titlefile>)" --body-file <bodyfile> -R
        <owner>/<repo>`.
      - Capture the returned issue number/URL immediately — it is the input
        to every later substitution and to the final report.

   c. If a create call fails partway through a batch, stop dispatching
      further creates, report which issues were created (with URLs) and
      which were not, and ask the user how to proceed. Do not retry
      silently and do not attempt to delete what was already created.

7. **Final report.** List every created issue's title and URL, in creation
   order. Note any drafted issue the user did not approve (not created) and
   any batch member left uncreated by a mid-batch failure.

## Cost discipline

The point of this skill is tier separation: drafting runs at planner's tier,
you relay and route. Do not re-derive or re-verify the file:line grounding
planner already did, and do not redraft issue content yourself in the main
session — amendments go back to the same planner via SendMessage so its
context and prior grounding work carry forward instead of restarting cold.
