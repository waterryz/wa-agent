# Billing and coordinated release — 2026-09-25

The protected service-billing routes supply the companion site's admin tab. They
separate balance, spend and invoice amounts, preserve manual-entry timestamps and
use optimistic versions to reject stale concurrent edits. Payment links point to
official provider consoles; no payment is initiated by this service.

Live provider reads also work before the manual ledger migration. Missing,
incomplete or failed storage returns `manual.status=unavailable`, no records and
`writable=false`; it never fabricates zero balances or invoices. The companion
UI displays that limitation alongside independently verified provider values.
The HTTP preview disables manual edits even when storage exists.

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

41 offline tests passed, including auth, provider-response
validation, concurrency, assistant behavior, report export and system-browser
selection, partial ledger failures and preview read-only behavior. Live chat and
owner admin reads are verified separately in the staging report. Ledger SQL,
live manual persistence, full bot report and WhatsApp runtime remain unverified.

## Dependency finding still open

The updated lockfile uses whatsapp-web.js 1.34.7 and its required Puppeteer 24.38.0.
The 2026-09-25 production audit still reports five high package findings cascading
from extract-zip (GHSA-jmr9-qjv8-65gv and GHSA-7pqw-9j4j-h8q3). There is no patched
extract-zip version in the advisory and the current compatible browsers 2.x chain
still uses it. Do not claim the assistant dependency audit is clean.

The draft now contains a narrow mitigation for the current LocalAuth deployment:

- Docker uses distribution Chromium and npm ci --omit=dev --ignore-scripts, so
  dependency lifecycle hooks cannot download and extract browser archives during
  that installation. A lock mismatch fails instead of falling back to npm install.
- Both WhatsApp entry points require an absolute, existing executable path via
  CHROME_PATH or PUPPETEER_EXECUTABLE_PATH. A missing/invalid path fails startup;
  neither entry point implicitly selects a downloaded browser from Puppeteer cache.
- Local Puppeteer installs default to skipDownload via .puppeteerrc.cjs. Environment
  overrides can change that local default; the Docker install also skips scripts.
- The current clients use LocalAuth directories, not RemoteAuth session archives.
  An offline test exercises the installed whatsapp-web.js initialization through
  LocalAuth to a mocked Puppeteer launch and verifies the explicit browser path.
  No actual browser or remote connection is started by that test.

The vulnerable package remains installed, and these measures do not repair its
archive extractor or prove every possible future use unreachable. Docker image
build, installed Chromium compatibility and live WhatsApp checks remain prelaunch
requirements. RemoteAuth, browser-download commands or custom install hooks would
need a fresh review. Do not force an untested major Puppeteer override to hide audit.

References: https://github.com/advisories/GHSA-jmr9-qjv8-65gv and
https://github.com/advisories/GHSA-7pqw-9j4j-h8q3.
