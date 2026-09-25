# HTTP access update

Web conversations now use an opaque signed session. A client obtains a token with
`POST /assistant/session`, then sends it in `x-web-session` for chat and polling.
The server assigns the identity; public `external_id`, driver identity, context
and reply suffix cannot choose another user's conversation. Polling also verifies
the conversation's channel and owner before loading replies.

Administrator operations require the existing `ADMIN_API_KEY` in `x-admin-key`.
Missing configuration fails closed. Query-string keys are not accepted. Both
Telegram and WhatsApp HTTP messages require the administrator header; the internal
WhatsApp listener is unchanged. The old test chat and legacy contact/escalation
APIs are administrator-only. Their local panels accept a key in a password field
and retain it only in memory. `/qr` and `/api/wa-status` also accept HTTP Basic
authentication (`admin` / existing key) for direct browser use over HTTPS.

## Coordinated release required

Do not deploy this PR alone. The web chat proxy must be updated together to keep
the session in a Secure, HttpOnly, SameSite=Lax cookie and forward `x-web-session`.
Its browser must discard old conversation pointers on 401/404. Historical rows
remain in the admin panel; a new anonymous session cannot reclaim old history by
presenting an old localStorage ID. Active visitors may need to resend a message
after the coordinated update.

The browser admin proxy must separately verify an administrator role or an explicit
Supabase Auth user-ID allowlist. A successful ordinary Supabase login is insufficient.
Configure and verify existing administrator access before deploying that change.

This branch incorporates the pending assistant optimization PR at 0c11f144. The
shared route conflict is resolved using the fail-closed, header-only guard while
retaining voice cancellation, latency limits, knowledge updates and operator checks.
Review this combined branch; the older optimization-only PR remains open for history
and must not be merged again after the combined branch is accepted.
This change does not enable voice, send messages, alter records, merge another PR
or change provider keys. Database RLS is a separate layer and does not replace HTTP
authorization.

## Read-only daily web report

`GET /assistant/reports/web-messages?start=<ISO timestamp>&end=<ISO timestamp>`
requires the same administrator header and returns only public web conversation
messages from the existing journal. Telegram is collected by the bot itself;
WhatsApp and internal knowledge-editor chats are excluded. The reporting window
is half-open, at most 26 hours (including 25-hour DST days), and cannot end in the
future. Queries use bounded ID pagination and a fixed maximum ID, a 15-second
database request deadline and a 5,000-message limit. Errors/overflows fail the
export instead of returning a silently truncated or empty successful report.

Messages retain roles and timestamps. One preceding user message is marked as
context, not counted as a question from this period. Current conversation status
is not used to reconstruct a past outcome. Credentials, session identifiers,
provider metadata and raw photos are not exported. Contact names are current
labels, not historical identity evidence.

Set `ASSISTANT_DIGEST_COVERAGE_START` only after verifying that every public web
chat entry point records to the shared journal. Until that point the export is
explicitly incomplete and cannot activate daily delivery. The bot companion at
`web_digest_client.py` combines this export with its Telegram/application/service
journal and keeps the report incomplete if either source is unavailable. This
PR neither activates a scheduler nor sends the report.

## Validation

`npm test`

Tests use synthetic identities and a stubbed assistant/database. They check two
independent sessions, cross-conversation refusal, identity spoofing, expired/tampered
tokens, both trusted chat channels, query-key refusal, missing configuration, legacy
admin APIs and QR authentication. No production conversations or model calls are used.
