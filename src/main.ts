import { run } from './run.ts';

// Entrypoint: invoked by the GitHub Actions runner via `dist/index.js`.
await run();
