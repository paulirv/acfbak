import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

// Run tests inside the Workers runtime (Miniflare), so bindings declared in
// wrangler.toml — including the R2 bucket binding env.BACKUPS — are available
// to tests with a local, in-memory R2 implementation. No live Cloudflare
// account or credentials required.
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        // Per-test isolated storage trips on R2's SQLite WAL (-shm) file in
        // this miniflare/pool version. These smoke tests use distinct keys, so
        // sharing storage within the file is safe and sidesteps the bug.
        isolatedStorage: false,
        wrangler: { configPath: "./wrangler.toml" },
      },
    },
  },
});
