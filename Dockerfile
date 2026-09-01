FROM node:23-bookworm-slim

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.6.5 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . ./

ENV NODE_ENV=production
EXPOSE 3100

CMD ["pnpm", "web"]
