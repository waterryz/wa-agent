# Assistant refresh — 2026-09-22

Common, approved RU/EN questions now return deterministic answers before retrieval or generation. Operator takeover is checked first; both user messages and replies stay in conversation history. Personal balance/payment questions and ambiguous text do not match a generic financial answer. Service facts are based on the current Mobile handbook and the owner's DMV form instructions.

Telegram requests require the existing `ADMIN_API_KEY` in `x-admin-key`. Set the bot's `ASSISTANT_ADMIN_KEY` to the same value before this release; do not put either secret in source. The matching bot release sends this header and detects `/assistant/capabilities`, so it can run before this update.

Voice uses `OPENAI_API_KEY`, already used by the assistant's other OpenAI features. Optional `TRANSCRIBE_MODEL` defaults to `gpt-transcribe`. Audio language is detected from speech; UI language is not forced on the recording. Limits are 12 MB, 20 requests/hour per Telegram ID, and a 90-second transcription timeout. The matching bot limits recordings to five minutes and shows the recognized text. A short cache prevents repeated processing of the same recording. Voice is advertised only if the authenticated capabilities response reports an API key.

Photo categories include service receipts and DMV forms. The matching bot stores original evidence under the vehicle and staff review category. Extraction never proves payment or completed service.

`package-lock.json` now includes the existing `qrcode` dependency that was missing from the old lockfile, allowing `npm ci` to resolve the declared package set.

## Validation

`node --test test_fast_answers.js test_assistant_routes.js`

Tests cover exact FAQ matches, private-question/photo bypass, operator mode, conversation history, HTTP authentication, untrusted driver fields, audio limits and mocked RU/EN/Georgian transcripts. Mocked transcripts do not validate actual recognition accuracy: check a real sample in each language after deployment, plus one photo and one uncommon question. This patch adds voice input; it does not synthesize spoken replies.

Roll back by reverting the release commit. No schema migration or knowledge-base overwrite is included.
