---
description: Drives a feature, fix or refactor in the JASS Panel from scope to summary: reads the design, explores, plans, hardens, implements with tests, verifies, reviews and syncs docs, using the project's agents. Use for any change larger than a few lines.
argument-hint: [description of the feature, fix or refactor]
---

# /orchestrator

**Task**: $ARGUMENTS

You are coordinating work on **JASS Panel**, a small daemon and React UI that manages Minecraft servers as systemd user units
beside the JASS website. `docs/DESIGN.md` is the architecture of record, `PLAN.md` is the work queue, `CLAUDE.md` holds the
working rules, and the `jass-panel-stack` and `typescript-coding-standards` skills apply throughout.

**Git is read-only.** `git status`, `diff`, `log` and `show` are fine. Never commit, push, branch, stage, reset, revert, stash, or
`git init`, and never let a subagent do so.

**No attribution in shipped text.** No code comment, doc line or commit-ready text may mention AI agents, reviews, `PLAN.md`
phases or decision numbers. Translate a finding into the plain rule or failure it prevents.

**No privilege by default.** Use `sudo` only when the user has given the credential in this session for a named job, kept in a
0600 file outside the repository and deleted afterwards; never write it into the repository, a command line, a log or a test.
Never touch a real server or the real proxy configuration. Anything else needing privilege is written down for the user to run.

## Principles that decide close calls

- Small on purpose. Check the size budgets in DESIGN §14 and the out-of-scope list in §13 before adding anything. If a task wants
  a job engine, a driver layer, a state machine for operations, or a root helper, stop and ask: it is probably the wrong shape.
- Wrap the OS rather than reimplement it.
- Unknown is not a safe value.
- A change that only works against a fake is not done. Say what was proved on a real Paper and what was not.

## Phases

1. **Scope.** Read the relevant DESIGN sections and the `PLAN.md` item. Restate the task and the acceptance criteria. Ask the user
   about anything ambiguous that changes what you build; do not ask about choices with a sensible default, say which you took.
2. **Explore.** Read the code and fixtures involved (use the Explore agent for broad searches). Note where the design and the code
   disagree.
3. **Plan.** For anything touching more than two modules, write a short plan: files, data flow, the interrupt path of every
   operation, and the tests. Check it against the invariants in `jass-panel-stack`.
4. **Harden the plan.** For lifecycle, authorization, files, backups, schedules, the install script, migrations, or anything reading
   `process.env`, run `hardening-analyst` on the plan before writing code, and fold its findings into the plan.
5. **Implement with tests.** Tests are part of the change: pure logic gets unit tests, parsers get captured-output fixtures,
   security-relevant code gets hostile-input tests, lifecycle code runs a fake Paper under the real `systemctl --user` with unique
   unit names removed in `finally`.
6. **Verify.** Run `npm run typecheck`, `npm run lint`, `npm test` (and `npm run build` when the bundle or server/shared boundary
   changed) once per pass, after the edits for that pass are done. Rerun a failure once before acting on it. Use
   `build-error-resolver` for anything that is not a one-line fix.
7. **Review.** Always `code-reviewer`. Add `security-reviewer` for the gate, authorization, paths, subprocesses, secrets or outbound
   HTTP; `silent-failure-hunter` for lifecycle, parsing or cleanup; `typescript-reviewer` for type or schema work;
   `react-reviewer` for UI; `database-reviewer` for migrations or queries; `performance-optimizer` for polling, tailing or fan-out.
   For risky areas run `hardening-analyst` again on the diff. Fix what is real; report what you decline and why.
8. **Docs.** Run `doc-updater`. Update the commands block and environment table in `CLAUDE.md` and `AGENTS.md` in the same change
   that adds or renames a script or variable, and `.env.example` with them.
9. **Library.** If the hardening pass found a defect class not in its library, add it as one entry, merging or deleting another
   if the 40-pattern cap would be passed. Delete patterns whose feature was cut.
10. **Summarize.** What changed, what was verified and how (and what only a real machine can verify), what you declined, and what
    the user must do themselves. Remove landed items from `PLAN.md`.
