# Node 22 + системный Chromium для whatsapp-web.js (puppeteer)
FROM node:22-slim

# Устанавливаем Chromium и шрифты (для рендера WhatsApp Web в headless)
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Puppeteer не качает свой Chromium — используем системный
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV CHROME_PATH=/usr/bin/chromium

WORKDIR /app

# Сначала зависимости (кэшируется отдельно от кода)
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Затем код
COPY . .

# Railway сам задаёт PORT
EXPOSE 3000

CMD ["node", "server.js"]