# Деплой веб-версии на Railway

`web.js` = веб-чат с Alex (тест без WhatsApp) + панель исключений.
WhatsApp / puppeteer / Chrome для веб-версии НЕ нужны.

- `/` — чат с Alex
- `/exceptions.html` — панель исключений и переданных вопросов
- `POST /api/chat` — API чата

## 1. Миграции в Supabase (один раз)
В Supabase → SQL Editor выполни:
- `supabase_migration.sql` (стиль)
- `knowledge_migration.sql` (факты)
- `web_migration.sql` (исключения + переданные вопросы)

## 2. Railway — переменные окружения (Variables)
Обязательно:
- `MOONSHOT_API_KEY`
- `OPENAI_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`

Рекомендуется:
- `PUPPETEER_SKIP_DOWNLOAD=true` — чтобы `npm install` не качал Chromium (для веба он не нужен; ускоряет/стабилизирует билд)

Опционально:
- `AGENT_NAME=Alex`, `OWNER_NAME=Антон`
- `KIMI_MODEL=kimi-k2.6`, `KIMI_MAX_TOKENS=4096`

`PORT` Railway задаёт сам — код его читает, ничего указывать не нужно.

## 3. Запуск
Railway по умолчанию выполнит `npm start` (= `node web.js`).

### Вариант А — через GitHub
Запушь папку `wa-agent` в репозиторий и подключи его в Railway (New Project → Deploy from GitHub).

### Вариант Б — без коммита, через Railway CLI
```bash
npm i -g @railway/cli
railway login
railway init        # или railway link к существующему проекту
railway up          # зальёт текущую папку (node_modules/chats_tmp исключены через .gitignore)
```

## 4. Готово
Открой выданный Railway URL — это чат с Alex. История диалога хранится в браузере; сервер без состояния.

## Локально
- Веб-чат: `npm run web` → http://localhost:3000
- WhatsApp-бот: `npm run bot`
