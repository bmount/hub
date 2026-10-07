import type { Env as HubEnv } from "../src/env";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";

// The pool types `cloudflare:test`'s env as Cloudflare.Env; the hub's bindings plus the test-only migrations.
declare global {
  namespace Cloudflare {
    interface Env extends HubEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
