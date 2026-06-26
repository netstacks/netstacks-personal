# Market Analysis: NetStacks Terminal — Free + Support-Based Monetization

> Deep research run (June 9, 2026): 106 agents, 24 sources fetched, 117 claims extracted,
> 25 adversarially verified (23 confirmed, 2 refuted). Pricing data live as of June 2026.

## Verdict: Conditional GO on the market — NO-GO on support-only revenue

There is a real, growing market for exactly this product. But **no successful comparable
company in this space survives on paid support alone.** Every one of them — NetBox Labs,
Network to Code, Grafana Labs, Unimus, VanDyke, MobaTek — monetizes through licensed
features, managed cloud, or per-device/per-seat subscriptions, with support bundled
*inside* paid tiers rather than sold standalone. The evidence points strongly to keeping
the free terminal but making the **Controller tier the product you charge for**.

---

## 1. The market is real and growing

- Network automation: **$7.88B (2025) → $12.38B (2030), 9.4% CAGR** per MarketsandMarkets —
  the most *conservative* of 5+ analyst firms; others claim up to 22–25% CAGR.
  (A larger Mordor figure of $36.86B was tested and refuted in verification, so treat
  absolute TAM numbers cautiously.)
  [Source](https://www.marketsandmarkets.com/Market-Reports/network-automation-market-156261086.html)
- Services are the faster-growing segment (~19.4% vs ~18.5% CAGR) — directionally
  favorable, but "services" there means professional services attached to vendor
  products, not support-on-free-software.
  [Source](https://www.mordorintelligence.com/industry-reports/network-automation-market)

## 2. What incumbents actually charge — and for what

| Segment | Anchor | Model |
|---|---|---|
| Individual terminal | Termius Pro ~$120/yr, SecureCRT $119, MobaXterm $69 | License/subscription, never support-only |
| **Team tier** | **Termius Team $20/user/mo, Business $30/user/mo** | Shared vault, RBAC, SSO — terminal itself is free |
| Config management | Unimus: 10 devices free, then $6.90–$9.70/device/yr | Per-device subscription |
| Enterprise AI netops | NetBrain: ~$54–$136/node/yr by module, **~$4,500/seat/yr** (verified via Texas DIR government contract) | Quote-based licensing |

Sources: [termius.com/pricing](https://termius.com/pricing) ·
[vandyke.com/pricing](https://www.vandyke.com/pricing/index.html) ·
[mobaxterm.mobatek.net/subscription](https://mobaxterm.mobatek.net/subscription.html) ·
[unimus.net/pricing](https://unimus.net/pricing.html) ·
[NetBrain Texas DIR contract PDF](https://www.cloudingenuity.com/contracts/5272/5272_Netbrain.pdf)

Two findings matter most:

1. **A free terminal with AI features is already table stakes, not a differentiator.**
   Termius gives away a commercial-use terminal *including AI autocomplete* in its free
   tier. You can't charge for what Termius gives away.
2. **The monetization wedge is the team layer, not the terminal.** Termius's paid deltas
   are exclusively shared vault, collaboration, granular access control, SSO — exactly
   the Controller feature set (RBAC, alert ingestion, audit, ServiceNow/JIRA). That layer
   competes in the NetBrain price band ($1k–$4.5k/seat/yr), two orders of magnitude above
   the $119 terminal band.

## 3. Does free + paid-support work? The pattern is unanimous

- **NetBox Labs**: tens of thousands of installs free; CEO reports "tremendous demand for
  support, assistance, and access to advanced features" — but they monetize via NetBox
  Enterprise (launched March 2024: support **plus** enterprise-only ServiceNow/discovery
  integrations). 60+ customers incl. seven Fortune 500 within a year; $35M Series B
  (July 2025).
  [Source](https://www.globenewswire.com/news-release/2024/03/12/2844549/0/en/NetBox-Labs-Announces-NetBox-Enterprise-Enterprise-Grade-Fully-Supported-Self-Managed-NetBox-Offering.html)
- **Network to Code / Nautobot**: started services-led, then explicitly moved to
  open-core in April 2026 — paid tiers bundle 24×7 support **with** proprietary tooling
  (device discovery, dashboards, NautobotGPT AI).
  [Source](https://networktocode.com/nautobot/nautobot-professional/)
- **Grafana Labs**: $250M ARR (2024) → $400M+ (2025), but the engine is **Grafana
  Cloud**, growing twice as fast as self-managed/support-style revenue.
  [Source](https://grafana.com/press/2024/08/21/grafana-labs-soars-past-250m-arr-and-5000-customers-completes-270m-primary-and-secondary-transaction-and-named-a-leader-in-the-gartner-magic-quadrant-for-observability-platforms/)
- **Unimus, VanDyke, MobaTek**: all license-fee businesses; support SLAs (community →
  email → 8/5 → 24/7) appear only as *tier attributes within* paid plans.

Honesty note from the verification pass: support-only viability is answered by **absence
of positive evidence** — no verified case of a pure-support business succeeding *or*
formally dying in this category. But zero-for-six among the closest comparables is a
strong prior. The a16z thesis ("there will never be another Red Hat") came up repeatedly:
support-only invites freeriding by the customers most able to pay, because they're the
ones who can self-support.
[Source](https://a16z.com/why-there-will-never-be-another-red-hat-the-economics-of-open-source/)

## 4. Recommended model for NetStacks

The evidence converges on a three-layer hybrid:

1. **Free forever** — the terminal app: SSH/Telnet/SFTP, local vault, snippets, basic
   topology. This is the distribution engine (NetBox built hundreds of thousands of
   installs this way; that installed base *is* the asset).
2. **Paid Controller (team tier), $20–30/user/mo anchor** — shared vault, RBAC, audit,
   alert ingestion, ServiceNow/JIRA, MOP approval workflows. Alternatively meter
   per-managed-device (Unimus-style) — likely better for MSPs, who manage many networks
   per seat and value vaults/MOPs most.
3. **Enterprise tier with AI automation, $1k+/seat/yr headroom** — agentic
   troubleshooting, MOP automation, compliance reporting — priced against NetBrain
   ($4,500/seat MSRP), with 24/7 SLA support as a tier differentiator *inside* it.

**Gate the AI assistant.** The biggest unresolved risk: no verified data exists on what a
free multi-LLM CCIE assistant does to unit economics, and AI-SaaS margin-compression
literature suggests it's the one free feature that actively costs money per user.
Practical options: BYO-API-key in the free tier (the settings-driven provider
architecture already supports this) or metering AI in paid tiers — Termius appears to
gate its heavier "AI Agent" similarly.

## 5. Key risks and unknowns

- **Free-to-paid conversion is unquantified.** The one numeric claim (Grafana ~0.025%)
  was refuted in verification — don't build revenue projections on a conversion
  assumption; instrument and measure instead.
- **TAM figures vary ~4x across analyst firms**; use the conservative one for planning.
- Cisco / Juniper Marvis / Selector AI pricing couldn't be verified — their
  hardware-bundled AI may compress the standalone AI-netops price band.
- Vendor figures (Grafana ARR, NetBox install counts) are self-reported marketing, not
  audited.
- Pricing data is time-sensitive (June 2026); Network to Code's commercial packaging is
  only ~2 months old with no track record.

## Open questions for follow-up research

1. What free-to-paid conversion rate is realistic for a freemium network-ops tool?
2. What do AI inference costs do to free-tier unit economics — BYO-key vs metered vs
   paid-gated?
3. How are Cisco, Juniper Marvis, and Selector AI actually priced, and does
   hardware bundling compress the standalone AI-netops price band?
4. Do MSPs represent a distinct, higher-willingness-to-pay segment justifying
   per-managed-device pricing instead of per-seat?

---

**Bottom line:** Free product, yes — it's how this category wins distribution.
Support-based revenue, yes — but only as the SLA ladder inside paid Controller/Enterprise
tiers, never as the sole product. The Controller tier already architected is, per the
market evidence, the actual business.
