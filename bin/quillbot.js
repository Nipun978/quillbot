#!/usr/bin/env node

import { main } from '../src/index.js';

main().catch((err) => {
  console.error('\nFatal error:', err?.message || err);
  process.exit(1);
});
