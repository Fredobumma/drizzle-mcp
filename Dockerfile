# Builds drizzle-mcp from this repository and serves the sample blog schema from
# the tests, on an in-process Postgres (PGlite), so the server can be started and
# inspected without a project of your own. Pass --config to point it at yours.
# The full node image, not slim: the test drivers include better-sqlite3, which
# compiles where no prebuilt binary fits.
FROM node:22

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# Create the sample's tables, so every tool has something to read
RUN cd test/fixtures/blog-pg && ../../../node_modules/.bin/drizzle-kit push --force

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["--config", "test/fixtures/blog-pg/drizzle.config.ts"]
