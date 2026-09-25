# Billing and coordinated release — 2026-09-25

The protected service-billing routes supply the companion site's admin tab. They
separate balance, spend and invoice amounts, preserve manual-entry timestamps and
use optimistic versions to reject stale concurrent edits. Payment links point to
official provider consoles; no payment is initiated by this service.

Apply service_billing.sql only during an approved rollout, verify service-role
permissions, and deploy the matching site proxy. The migration has NOT been applied.
Use the existing ADMIN_API_KEY for the server-to-server admin guard. No browser gets
that key. Keep the existing MOONSHOT_API_KEY server-only. Automatic Kimi balance
reads support only the verified global official endpoint; unsupported configured
gateways/regions disable automatic reads and top-up links.

OpenAI Costs is optional: configure OPENAI_BILLING_ADMIN_KEY plus explicit
OPENAI_BILLING_PROJECT_IDS only after verifying the account and scope. It reports
costs, not credits. Other providers use dated manual records. Unknown is not zero;
the $30 monthly planning target is not a spending limit or verified hosting bill.

35 offline tests passed after dependency updates, including auth, provider-response
validation, concurrency, assistant behavior and report export. No model/provider
request, WhatsApp session, live report, database migration or deployment was run.

## Dependency finding still open

The updated lockfile uses whatsapp-web.js 1.34.7 and its required Puppeteer 24.38.0.
The 2026-09-25 production audit still reports five high package findings cascading
from extract-zip (GHSA-jmr9-qjv8-65gv and GHSA-7pqw-9j4j-h8q3). There is no patched
extract-zip version in the advisory and the current compatible browsers 2.x chain
still uses it. Do not claim the assistant dependency audit is clean.

The Dockerfile skips Puppeteer browser downloads and uses distribution Chromium;
npm ci now fails on a lock mismatch instead of falling back to npm install. This
avoids that browser-download path in the documented image but does not remove the
vulnerable package or prove all archive paths unreachable. Before launch, resolve
with an upstream-compatible dependency or document and verify a narrow runtime
mitigation. Do not force an untested major Puppeteer override just to silence audit.
Docker build and live WhatsApp compatibility remain untested.

References: https://github.com/advisories/GHSA-jmr9-qjv8-65gv and
https://github.com/advisories/GHSA-7pqw-9j4j-h8q3.
