# Agent Rules for CDN Caching Proxy

## Workflow & Batch Rules

1. **Branch Isolation**:
   - Each batch must be developed on its designated branch (e.g., `batch-01`).
   - Do not merge to main unless explicitly instructed.

2. **Feature Progression**:
   - Implement features strictly in the order specified by the prompt.
   - For each feature:
     1. Mark status as `IN_PROGRESS` in `FEATURES.md`.
     2. Implement the feature code and corresponding unit / integration tests.
     3. Verify all tests pass cleanly.
     4. Mark status as `DONE` (or `PARTIAL` if explicitly instructed) in `FEATURES.md`, documenting the evidence (test files and exact command).
     5. Commit the feature with a descriptive commit message (`feat: ...`). Exactly one commit per feature.

3. **Scope Control**:
   - Work ONLY on the features specified for the current batch.
   - Any features only partially claimed or deferred to later batches must be marked `PARTIAL` or left for their respective batches.
   - Do not begin the next batch until explicitly requested.

4. **Testing Standards**:
   - Every feature must be backed by automated tests verifying normal behavior, edge cases, error modes, and safety invariants.
   - No mock shortcuts where real integration tests are required (e.g., real local HTTP origin server, TLS certificates).

5. **Live Verification**:
   - Perform mandatory end-to-end live verification steps with actual command outputs (e.g., curl requests against the running proxy and origin).
   - Paste genuine raw outputs in the completion report.

6. **Documentation Maintenance**:
   - Update `docs/CONFIG.md` and `docs/KNOWN_GAPS.md` at the conclusion of every batch.

7. **Clean Gates**:
   - Verify typecheck, lint, and all test suites pass without error before and after each batch.

8. **Injected Dependencies**:
   - Always inject clock / time abstractions; never call `Date.now()` directly in cache logic.

9. **Batch Completion Report**:
   - When all features in the batch are finished, print a structured report containing:
     (a) Batch Summary (branch, feature count, status breakdown)
     (b) Feature Status Table (number, name, status, evidence)
     (c) Key Architectural & Scope Decisions
     (d) Git Commits
     (e) Live Verification Output
     (f) Lines of code added and deleted in this task, from `git diff --shortstat <base-branch>...HEAD`, plus a per-file breakdown from `git diff --numstat`

