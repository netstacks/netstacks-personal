# Support

NetStacks is built by a small team. This document describes what kind of
support that means in practice — what's free, what's paid, and how we
triage.

## Free support

Free users get:

- **Source code.** It's all here. Read it, build from it, modify it.
- **Documentation.** See `README.md`, `docs/`, and the security and
  contributing docs in this repo.
- **Community help via Discussions.** Open a question in
  [GitHub Discussions](https://github.com/netstacks/netstacks-terminal/discussions).
  Other users may be able to help. We chime in when time allows but
  cannot guarantee a response on the free tier.
- **Bug reports via Issues.** With caveats — see below.

What free users do **not** get:

- Response-time guarantees.
- Phone, email, or chat support.
- Help configuring the application for your specific environment.
- Custom feature development.

## Issue triage

To keep the project sustainable, we apply a few standing policies:

- Issues without a minimal reproducer will be closed. "It crashes
  sometimes" is not actionable; "it crashes when I do X with input Y on
  platform Z, here's the log" is.
- Feature requests filed as Issues will be closed. Open a Discussion in
  the **Ideas** category instead — if there's community interest and a
  contributor willing to do the work, it can graduate to an Issue + PR.
- Stale issues (no activity for 45 days) auto-close. Re-open if the issue
  is still relevant and you have new information.
- We reserve the right to decline any issue or feature request without
  detailed explanation.

## Paid support

If you need response-time guarantees, dedicated help, or custom work,
NetStacks offers commercial support:

- **Email Support Contract** — business-day response, 4-hour SLA — $3,500/yr
- **Premium Support Contract** — 24/7 critical, named contact — $7,500/yr
- **Per-incident support** — $300/hr business, $500/hr after-hours, 4-hour
  minimum — for one-time emergencies
- **Office hours** — $250/30-min slot, bookable via Calendly
- **Custom integration** — quoted per engagement, $5K–30K typical

See <https://netstacks.net/support> for details and to purchase.

For team and enterprise deployments, the commercial NetStacks Controller
includes coordinated support — see <https://netstacks.net/enterprise>.

## What kind of issues to file

**File an Issue when:**
- You hit a bug with a clear reproducer.
- You spot a documented behavior that's actually broken.
- A security finding has been triaged and we have asked you to open a
  public tracking issue.

**File a Discussion when:**
- You have a question.
- You want to suggest a feature.
- You want to share something you built.
- You need help configuring NetStacks for your environment.

**Email security@netstacks.net (NOT a GitHub issue) when:**
- You found a security vulnerability. See `SECURITY.md`.

## Release cadence

We ship releases when there are merged changes worth shipping —
typically every few weeks, sometimes more frequently for critical fixes.
There is no fixed release calendar. Signed installers are published to
<https://netstacks.net/download>; subscribe to release announcements at
<https://netstacks.net/releases> to be notified.
