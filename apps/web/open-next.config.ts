import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Minimal config: no R2 incremental cache required for first free deploy.
export default defineCloudflareConfig({});
