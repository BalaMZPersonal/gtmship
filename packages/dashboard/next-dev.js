#!/usr/bin/env node
// Wrapper to set WATCHPACK_POLLING before Next.js initializes its file watchers.
// macOS has a low default file descriptor limit (256) which causes EMFILE errors
// with native fs.watch() in monorepos. Polling mode avoids this.
process.env.WATCHPACK_POLLING = "true";
require("next/dist/bin/next");
