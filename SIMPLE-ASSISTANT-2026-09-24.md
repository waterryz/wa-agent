# Small assistant update

Ordinary Kimi K2.5/K2.6 answers and query translation now disable thinking, use bounded output, and do not repeat failed SDK requests automatically. The configured model/provider is retained. Polite variants of common RU/EN questions use the same approved templates; compound/personal questions still go through the assistant. Approved newer broadcast drafts bypass fixed factual templates so updated knowledge can be retrieved.

The assistant has searchable text extracted from the original 84-page RU and EN Mobile handbooks, with page references and PDF SHA-256 hashes. It fetches the canonical public test catalog with a 60-second cache and a 3-second fetch timeout. Exact known RU test questions use the current answer key without generation; the bundled 70-question snapshot is a matching hint, not a stale-answer fallback. If the catalog cannot be refreshed, old answers are not presented as current. Training here means source preparation and deterministic validation, not fine-tuning a model or a measured live provider benchmark.

New/edited broadcast posts remain pending drafts. The existing admin UI still owns approval/rejection. A notifier reads pending drafts, sends a short notification to the configured internal channel, and stores successful delivery IDs in the existing `tg_poll_state` table. Normal retries/restarts are deduplicated by draft ID and text revision. An ambiguous Telegram success followed by a failed DB write can still produce a duplicate; Telegram does not supply an idempotency key for `sendMessage`. Run one collector instance. Posts that fail processing are not acknowledged past the failure.

Applications are not guaranteed cars or reservations. The assistant states that availability, terms and pickup time are confirmed separately by Prime Fusion. Related Telegram application copy is in a separate testbot PR.

Voice is disabled as requested; shared OpenAI credentials and embeddings are retained. Missing admin credentials now fail closed for draft review and other admin routes. Operator takeover is checked again before delivering an AI reply. Provider failures preserve the question for review.

## Configuration before enabling notifications

- Keep the existing `TG_KB_BOT_TOKEN` and verified broadcast source `TG_KB_CHAT_ID`.
- Set `KB_NOTIFY_CHAT_ID` to the verified INTERNAL admin channel ID, not the broadcast source.
- Use existing `TELEGRAM_BOT_TOKEN` with access to that channel, or explicitly set `KB_NOTIFY_BOT_TOKEN`.
- Set `KB_ADMIN_URL` to the existing HTTPS browser admin page. Do not include an access key or other query parameters in the link. Without these settings, notification delivery stays disabled and drafts remain saved.
- Existing `knowledge_staging`, `knowledge`, and `tg_poll_state` migrations must already be present. No new schema migration is introduced.
- `ASSISTANT_REPLY_MAX_TOKENS` defaults to 1200; ordinary generation timeout defaults to 30 seconds, translation to 6 seconds, embeddings to 8 seconds. Database and transport delays mean these are not an end-to-end latency guarantee.

## Validation

`npm test` runs 18 offline/local HTTP tests, including all 70 exact test answers, changed/unavailable catalogs, source retrieval, FAQ privacy boundaries, draft notification retries and revisions, operator takeover and missing admin keys. No live model, Telegram delivery, tenant data mutation or voice transcription is used. The original PDF page 52 was rendered and checked against the extracted oil table.

Real provider quality/latency and Railway configuration are still unverified. Prior audit findings about public conversation polling, untrusted web identity and the legacy `/api/chat` path are separate follow-up work, not claimed fixed here. The legacy API receives agent prompt/retrieval improvements but does not gain the core's deterministic FAQ path.

Rollback: revert this feature commit. No paid subscriptions, provider changes or production configuration changes are part of this PR.
