#!/usr/bin/env node
import { main } from './server.js';

main().catch((err) => {
  console.error('site-use failed to start:', err);
  process.exit(1);
});
