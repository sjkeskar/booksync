// Tiny static server for UI previews: serves dist/ and dev/ (mock chrome API).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.map': 'application/json' };
createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = normalize(url.pathname).replace(/^[\\/]+/, '');
  if (p.includes('..')) return res.writeHead(400).end();
  for (const root of ['dev', 'dist']) {
    try {
      const data = await readFile(join(here, root, p || 'options-preview.html'));
      res.writeHead(200, { 'Content-Type': types[extname(p)] ?? 'text/html' });
      return res.end(data);
    } catch {}
  }
  res.writeHead(404).end('not found');
}).listen(Number(process.env.PORT) || 5178, function () {
  console.log(`preview on http://localhost:${this.address().port}`);
});
