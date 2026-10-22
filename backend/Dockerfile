FROM oven/bun:1

WORKDIR /app

COPY package.json bun.lock ./
COPY frontend/package.json ./frontend/
COPY backend/package.json ./backend/
COPY shared/package.json ./shared/
COPY contracts/package.json ./contracts/

RUN bun install --frozen-lockfile

COPY backend ./backend
COPY shared ./shared

WORKDIR /app/backend

ENV NODE_ENV=production
EXPOSE 3000

CMD ["bun", "src/index.ts"]
