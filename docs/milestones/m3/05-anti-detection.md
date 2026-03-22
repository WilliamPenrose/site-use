# Capability 05: Anti-Detection Enhancement

> Upstream: [M3 Overview](00-overview.md) — Group B
> Status: Research spikes required before implementation

## Positioning

Group B — each capability requires a research spike before deciding whether to implement. This document defines the research scope and acceptance criteria. Implementation details are added per-item after research concludes.

---

## Candidate Capabilities

| # | Capability | Purpose | Research Question |
|---|-----------|---------|-------------------|
| B1 | Canvas fingerprint noise | Prevent cross-site correlation tracking | Does Twitter do Canvas fingerprinting? Could noise injection trigger detection instead of preventing it? |
| B2 | WebRTC leak protection | Prevent real IP leak when using proxy | Does WebRTC actually leak IP with our setup? Can Chrome launch args disable it directly? |
| B3 | Ad/tracker domain blocking | Reduce noise DOM + faster page loads | Does blocking break Twitter functionality? Could it trigger anti-bot detection? |
| B4 | Rate-limit signal detection | Detect 429 / captcha page → throw `RateLimited` | What does Twitter rate-limiting look like in practice? HTTP 429? Page content change? Redirect? |

---

## Research Method

Each item follows a 3-step spike:

1. **Desk research** — search existing literature, open-source project experience, browser automation community knowledge
2. **Live verification** — observe actual behavior in site-use's Chrome profile
3. **Verdict** — implement / skip / defer, with rationale

---

## Acceptance Criteria

| Verdict | Condition |
|---------|-----------|
| **Implement** | Clear risk exists + implementation is simple + does not break normal functionality |
| **Skip** | Risk does not exist in Twitter scenario, or implementation may introduce new problems |
| **Defer** | Risk exists but low priority now; record in overview's open issues |

---

## Known Context

From the rate-limiting research in [03-rate-limiting.md](03-rate-limiting.md) and [milestone overview](../overview.md):

- Twitter **does not use Cloudflare** (confirmed in overview) — no Cloudflare challenge handling needed
- Twitter rate-limiting may manifest as HTTP 429 or in-page captcha — needs live verification
- WebRTC leak can likely be addressed via Chrome launch args (`--disable-webrtc` or `--force-webrtc-ip-handling-policy`) without complex page injection
- Canvas noise is a double-edged sword — some detection systems specifically look for inconsistent Canvas output as a bot signal

---

## Dependencies on Group A

- **B4** (rate-limit signal detection) depends on `RateLimited` error type defined in [04-error-handling.md](04-error-handling.md) — implement B4 after Group A is complete
- **B1, B2, B3** have no Group A dependencies — can proceed independently

---

## Implementation Approach

Each capability is independent:
- Research passes → append implementation design and proceed
- Research fails → record conclusion, mark as "Skip" or "Defer"

No need to wait for all research spikes to complete — any item that passes research can be implemented immediately.

---

## Validation

Validation criteria are defined per-item after research concludes, since they depend on the specific implementation chosen.

---

## Research Log

> This section is updated as research spikes are completed.

### B1: Canvas Fingerprint Noise
- Status: Not started

### B2: WebRTC Leak Protection
- Status: Not started

### B3: Ad/Tracker Domain Blocking
- Status: Not started

### B4: Rate-Limit Signal Detection
- Status: Not started
