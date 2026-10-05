import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import path from 'node:path';

// Real CLI and static HTTP, not a browser engine. No watcher or destructive
// endpoint is exercised. Reused for checkout, tarball and Git installations.
export async function smokeCli(command, args, repoRoot) {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const address = reservation.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  const child = spawn(command, [...args, repoRoot], {
    cwd: repoRoot, env: { ...process.env, PORT: String(port),
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`CLI did not start: ${stderr}`)), 10000);
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`CLI exited ${code}: ${stderr}`)); });
      child.stdout.on('data', (chunk) => {
        if (String(chunk).includes('Canopy viewing')) { clearTimeout(timeout); resolve(); }
      });
    });
    for (const [url, type, pattern] of [
      ['/', 'text/html', /<script type="module" src="\/main.js"><\/script>/],
      ['/styles.css', 'text/css', /\S/],
      ['/main.js', 'text/javascript', /import .*from ['"]\.\/.*\.js['"]/],
      ['/app.js', 'text/javascript', /export /],
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}${url}`, { signal: AbortSignal.timeout(10000) });
      assert.equal(response.status, 200, url);
      assert.ok(response.headers.get('content-type')?.startsWith(type), url);
      assert.match(await response.text(), pattern, url);
    }
  } finally {
    child.kill();
    await exited;
  }
}
