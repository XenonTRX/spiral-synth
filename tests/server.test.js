// The static server, which is the only part of this project that listens on a socket.
//
// Both cases here are bugs that were real: a sibling directory whose name merely began the same
// way was served, and a single malformed percent-escape killed the process. Neither is reachable
// from off the machine - the server binds to 127.0.0.1 - but a project that tells people to run
// something owes them that the something is not trivially breakable.
//
// The port is claimed at run time rather than fixed. A hard-coded one collides the moment two
// copies of this file run at once, which `node --test` will happily do, and the failure looks
// like a broken server rather than a busy port.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.js');

/** A port nothing is listening on, found by briefly listening on one. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** A root to serve, with a same-prefixed sibling beside it holding something private. */
async function sandbox() {
  const base = await mkdtemp(path.join(tmpdir(), 'spiral-server-'));
  const root = path.join(base, 'app');
  await mkdir(root);
  await mkdir(path.join(base, 'app-private'));
  await writeFile(path.join(root, 'index.html'), '<h1>ok</h1>');
  await copyFile(SERVER, path.join(root, 'server.js'));
  await writeFile(path.join(base, 'app-private', 'notes.txt'), 'CANARY');
  return { base, root };
}

function start(root, port) {
  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let noise = '';
    child.stdout.once('data', () => resolve(child));
    child.stderr.on('data', (c) => { noise += c; });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`server exited with ${code}: ${noise}`)));
    setTimeout(() => reject(new Error('server did not start in time')), 5000);
  });
}

// `fetch` normalises `..` out of a URL before it reaches the wire, so a traversal attempt has to
// be written onto the socket by hand or there is nothing left to test.
function rawGet(port, target) {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let data = '';
    socket.setTimeout(3000);
    socket.connect(port, '127.0.0.1', () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('close', () => resolve(data));
    socket.on('timeout', () => { socket.destroy(); reject(new Error('timed out')); });
    socket.on('error', reject);
  });
}

test('the server serves its own root, refuses everything else, and survives a bad escape', async (t) => {
  const { base, root } = await sandbox();
  const port = await freePort();
  const child = await start(root, port);
  t.after(async () => { child.kill(); await rm(base, { recursive: true, force: true }); });

  await t.test('a normal file is served', async () => {
    const res = await rawGet(port, '/index.html');
    assert.match(res, /200 OK/);
    assert.match(res, /<h1>ok<\/h1>/);
  });

  await t.test('the bare root serves index.html', async () => {
    assert.match(await rawGet(port, '/'), /<h1>ok<\/h1>/);
  });

  await t.test('a sibling whose name shares the root prefix is refused', async () => {
    // The bug: `resolved.startsWith(root)` is a string prefix, so `app-private` matched `app`.
    const res = await rawGet(port, '/../app-private/notes.txt');
    assert.doesNotMatch(res, /CANARY/, 'served a file from outside the root');
    assert.match(res, /403|404/);
  });

  await t.test('ordinary deep traversal is refused', async () => {
    const res = await rawGet(port, '/../../../etc/passwd');
    assert.doesNotMatch(res, /root:/);
    assert.match(res, /403|404/);
  });

  await t.test('a malformed percent-escape is a 400, not a dead process', async () => {
    assert.match(await rawGet(port, '/%'), /400/);
    // The real assertion: it is still answering afterwards.
    assert.match(await rawGet(port, '/index.html'), /200 OK/, 'the server died on a malformed URL');
  });
});
