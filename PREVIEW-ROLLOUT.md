# Isolated HTTP preview

Owner authorized a protected test deployment on 2026-09-25. This entry point is
separate from the production `server.js`. Use `Dockerfile.preview` and
`node preview_server.js` in a NEW service only; never change the running service.

Required server variables:
- `ASSISTANT_PREVIEW_MODE=true`
- Two new, distinct, random secrets of at least 32 characters: `ADMIN_API_KEY`
  and `ASSISTANT_PREVIEW_KEY`. Never reuse the production administrator key.
- Existing approved provider/database configuration: `MOONSHOT_API_KEY`,
  `OPENAI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, and matching model settings.

Do not copy Telegram, knowledge-collector, email credentials or WhatsApp volumes.
The preview imports no WhatsApp entry point and starts no collector or scheduler.
All requests except `/health` require a server key. Site server configuration:
`ASSISTANT_API` = new preview service URL; the two keys match this new service.
Only the preview gate is attached to public chat calls, never the admin key.

Writes are restricted to new signed web sessions and their messages. Telegram /
WhatsApp chat identities, operator replies, read markers, knowledge edits,
approvals and billing edits are blocked, even for administrators. Admin GETs
still require the administrator key, not the preview gate. No send callbacks are
installed. Test web sessions use a separate signing key, so existing browser
sessions and customer conversation IDs cannot be reused to inject messages.
Conversation-detail GET/HEAD also skip the production router's implicit
mark-as-read write. Regression checks exercise the actual router behind the
preview gate and verify that production retains its existing behavior.

If using the existing Supabase project, synthetic web test conversations WILL
be stored in its journal and Kimi/OpenAI test calls consume normal API credits.
Use explicitly labelled fictitious test contacts; no real tenant messages.
This is not a fully isolated database or proof of live bot delivery.

Protect all Vercel staging deployments with owner-team login. Do not create
public protection-bypass links. `/health` confirms process availability only;
real database/model checks remain required after configuration.

The known five high WhatsApp extraction-chain audit findings remain. Preview
installs dependencies with scripts disabled and never loads WhatsApp, but does
not claim to repair the upstream packages. Production start behavior is unchanged.
