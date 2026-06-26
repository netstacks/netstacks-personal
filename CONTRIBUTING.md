# Contributing

Thanks for your interest. NetStacks is built by a small team and we
welcome contributions, but the bar for merging is deliberately set with
the realities of a focused team in mind: we prioritize changes that
align with the roadmap and that we are willing to maintain over time.

## Before you write code

- For anything beyond a small bug fix, open a
  [Discussion](https://github.com/netstacks/netstacks-terminal/discussions)
  first to align on whether the change fits the roadmap. PRs that land
  without prior discussion are likely to bounce.
- Search existing issues and PRs to make sure the work isn't already in
  flight or already been declined.
- Read `SUPPORT.md` to understand what is and isn't in scope for this
  project.

## Pull requests

- **DCO sign-off required.** Sign every commit:
  ```
  git commit -s -m "your message"
  ```
- **Tests required for code changes.** A bug fix should include a test
  that reproduces the bug. A new feature should include tests for the new
  behavior. Documentation-only PRs and pure cleanup PRs don't need tests.
- **Keep PRs small.** A focused 200-line PR has a much higher chance of
  landing than a 2000-line one. Split larger work into reviewable pieces.
- **Match the existing style.** `cargo fmt` for Rust, the project's ESLint
  rules for TypeScript. CI will reject formatting violations.
- **Write meaningful commit messages.** Imperative mood, short subject,
  blank line, then the *why* in the body. We squash on merge but readable
  commits help the review process.

## Acceptance criteria

A PR is mergeable when:

1. CI passes on all supported platforms (Linux, macOS, Windows for
   anything Tauri-side; Linux is sufficient for agent-only changes).
2. New code is covered by tests.
3. The change has been discussed and aligns with the roadmap (for
   anything non-trivial).
4. A maintainer has reviewed and approved the change.

## What is unlikely to land

- Large architectural reworks not previously discussed.
- New dependencies that significantly increase build size or attack
  surface, without a clear justification.
- Features that target Enterprise Mode (multi-user) — those belong in the
  closed Controller, not the open Terminal/Agent.
- Refactors driven by stylistic preference rather than a concrete problem.
- Changes that re-introduce license checks, tier gates, telemetry, or
  phone-home calls into the Local Agent.

## What's especially welcome

- Reproducers and tests for bugs you hit in real use.
- Vendor-specific knowledge-pack contributions for the AI assistant
  (under `agent/src/ai/knowledge_packs/`).
- Documentation improvements, particularly for build-from-source on the
  three platforms.
- Performance improvements with measurements.
- Security findings — report privately first; see `SECURITY.md`.

## Maintainers' prerogative

We reserve the right to decline any PR for any reason, including reasons
that aren't fully articulated at the time. Decline is not personal; it
usually means the PR doesn't fit the roadmap or we don't have the
bandwidth to support the new code over time. If your PR is declined,
you're welcome to maintain a fork.

## Code of conduct

All contributors and participants agree to abide by the
[Contributor Covenant 2.1](CODE_OF_CONDUCT.md).
