import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = process.env.PORT ? Number(process.env.PORT) : 5173;
const host = '127.0.0.1'; // local machine only, never exposed on the network

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  // decodeURIComponent throws on a malformed escape - a bare `/%` is enough - and an exception
  // out of this handler takes the whole process with it. One bad request should be one 400.
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split('?')[0]);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad request');
    return;
  }
  const resolved = path.normalize(path.join(root, urlPath === '/' ? '/index.html' : urlPath));

  // `startsWith(root)` alone is a *string* prefix, which lets a sibling whose name merely begins
  // the same way through: /../spiral-synth-private/notes.txt resolves outside the root and still
  // matches. Comparing against `root + sep` makes it a directory boundary instead.
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(resolved);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(port, host, () => {
  console.log(`Spiral Synth running at http://${host}:${port} (local only)`);
});
