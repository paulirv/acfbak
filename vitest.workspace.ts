import { defineWorkspace } from "vitest/config";
import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";

// Two test projects, split by what they actually need:
//
//   unit   — pure-logic tests (config validation, the Acquia API client,
//            backup-selection logic). They inject their dependencies (e.g.
//            fetch) and run in plain Node, so they are fast and immune to the
//            Workers-runtime shared-storage collision that bites when multiple
//            binding-backed test files share one Miniflare instance.
//
//   worker — integration tests that exercise real Worker bindings (the R2
//            binding env.BACKUPS) inside the Workers runtime via Miniflare,
//            using the bindings declared in wrangler.toml.
//
// Keeping them separate is the single source of truth for "does this test need
// the Workers runtime?": it's answered by which directory the file lives in.
export default defineWorkspace([
  {
    test: {
      name: "unit",
      include: ["test/unit/**/*.test.ts"],
      environment: "node",
    },
  },
  defineWorkersProject({
    test: {
      name: "worker",
      include: ["test/worker/**/*.test.ts"],
      poolOptions: {
        workers: {
          // Per-test isolated storage trips on R2's SQLite WAL (-shm) file in
          // this miniflare/pool version. These smoke tests use distinct keys,
          // so sharing storage within the file is safe and sidesteps the bug.
          isolatedStorage: false,
          wrangler: { configPath: "./wrangler.toml" },
          // Inject the manual-trigger secret for tests only (never committed to
          // wrangler.toml). In production it's set via `wrangler secret put`.
          miniflare: { bindings: { TRIGGER_TOKEN: "test-trigger-token" } },
        },
      },
    },
  }),
]);
