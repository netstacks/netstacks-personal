# Changelog

All notable changes to NetStacks Terminal are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Audience for this file is end users — what they should know about a
release. Internal refactors and commit-by-commit detail belong in the
git log, not here.

---

## [Unreleased]

This section accumulates changes since the last published release. It will
become the entry for the next tagged version.

### Added
- Open-source release of the NetStacks Terminal and Local Agent under
  Apache 2.0. NetStacks is now open-core: Personal Mode (this repo) is
  free and open; the commercial Controller for teams remains a separate
  product.
- `LICENSE` (Apache-2.0), `NOTICE` (third-party attributions), `README`,
  `CONTRIBUTING`, `SECURITY`, `SUPPORT`, and `CODE_OF_CONDUCT`
  (Contributor Covenant 2.1) at the repository root.
- GitHub issue templates and pull-request template under `.github/`.
- Continuous-integration workflow at `.github/workflows/ci.yml` covering
  agent, Tauri shell, and frontend across Linux / macOS / Windows.

### Changed
- `AppMode` is now `'standalone' | 'enterprise'` (previously
  `'basic' | 'professional' | 'enterprise'`). Personal Mode is the
  single standalone configuration.
- `license_tier` in the capabilities response is now
  `'standalone' | 'team' | 'enterprise'`. The free `basic` and paid
  standalone `professional` tiers no longer exist; standalone is
  full-featured.
- Default standalone capabilities expose every local feature. There is
  no longer a tiered subset.
- Distribution moved off GitHub Releases. Signed installers are now
  published to <https://netstacks.net/download>.

### Removed
- The Local Agent's license-validation module (`agent/src/license/`) and
  every call site. The agent no longer phones home and no longer holds a
  license-server URL.
- License-related dependencies from `agent/Cargo.toml`
  (`jsonwebtoken`, `zeroize`).
- All license/tier UI in the frontend: `LicenseContext`,
  `LicenseProvider`, `LicenseBanner`, `LicenseStatus`,
  `LicenseActivation`, `SettingsLicense`, `useLicense`, `AppGate`, the
  License tab in Settings, the BASIC chat-only system prompt, and every
  feature-gate that referenced "professional or enterprise tier".
- The plugin SDK and scaffold from this repository — plugins only run in
  the commercial Controller and now ship there instead.

### Security
- Jump-host SSH connections now use `StrictHostKeyChecking=accept-new`
  (TOFU). Previously they bypassed host-key checking entirely with
  `StrictHostKeyChecking=no`, which made man-in-the-middle attacks
  trivial against any device reached through a jump host.
- `fetch_controller_cert` (the bootstrap that retrieves the Controller's
  CA certificate during first-time setup) now requires the controller URL
  to use `https://` and to include a host. The TLS bypass remains
  intentional for the bootstrap step, but the URL is parsed and validated
  before the request fires.
- The terminal-log endpoints (`start_terminal_log`, `write_terminal_log`,
  `append_to_log`, `stop_terminal_log`'s read path) now confine all
  paths to `~/Documents/NetStacks/logs/` via canonicalization. Previously
  these endpoints accepted arbitrary user-supplied paths and constituted
  an arbitrary file-write / arbitrary file-read primitive.

### Fixed
- _(none for this release; no upstream-tagged version yet)_

---

<!--
Tagging conventions for future entries:
  - `## [X.Y.Z] - YYYY-MM-DD`
  - Keep entries user-visible (what changed in the binary they install)
  - Group under: Added / Changed / Deprecated / Removed / Fixed / Security
  - Link upgrade notes here when a release requires user action
-->
