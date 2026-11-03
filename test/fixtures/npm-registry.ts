import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import Type from 'typebox';
import { Compile } from 'typebox/compile';

const manifest = Compile(Type.Object({ name: Type.String(), version: Type.String() }, { additionalProperties: true }));

export async function npmRegistry(archives: readonly string[]) {
  const requests: string[] = [], failures: string[] = [];
  const packages = archives.map(path => ({ path, manifest: manifest.Parse(JSON.parse(execFileSync('tar',
    ['-xOf', path, 'package/package.json'], { encoding: 'utf8' }))) }));
  const tarballPath = (item: typeof packages[number]) =>
    `/${item.manifest.name}/-/${item.manifest.name.split('/').at(-1)}-${item.manifest.version}.tgz`;
  let origin = '';
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.headers.authorization, undefined, 'Registry fixture received authorization');
      const path = decodeURIComponent(request.url ?? '');
      requests.push(path);
      const archive = packages.find(item => path === tarballPath(item));
      if (archive) { response.end(readFileSync(archive.path)); return; }
      const item = packages.find(item => path === `/${item.manifest.name}`);
      if (item) {
        const bytes = readFileSync(item.path);
        const version = { ...item.manifest,
          dist: { tarball: `${origin}${tarballPath(item)}`,
            integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` } };
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ name: item.manifest.name, 'dist-tags': { latest: item.manifest.version },
          versions: { [item.manifest.version]: version } }));
        return;
      }
      failures.push(`Unexpected registry request for bundled dependency: ${path}`);
      response.writeHead(404); response.end('Only mipmux and its native helpers are served');
    })().catch(error => {
      failures.push(String(error)); response.writeHead(500); response.end('Registry fixture failed');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = Compile(Type.Object({ port: Type.Integer() })).Parse(server.address());
  origin = `http://127.0.0.1:${address.port}`;
  return { origin, requests, failures, close: () => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
  }) };
}
