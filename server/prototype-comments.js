// Throwaway #26 runner. No sidecar read/write and no agent integration.
import { createApp } from './app.js';

const port = process.env.PORT || 4176;
const server = createApp({ repoRoot: process.cwd(), prototypeEnabled: true });
server.listen(port, () => {
  console.log(`Comment prototype: http://localhost:${port}/?variant=A (also B/C)`);
});
