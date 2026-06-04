// Make the Worker's typed Env available as the test environment provided by
// @cloudflare/vitest-pool-workers (the `env` import from "cloudflare:test").
import type { Env } from "../src/worker/index.ts";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}
