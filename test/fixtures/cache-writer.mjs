import { ArtifactStore } from '../../dist-test/src/workspace/artifact-store.js';
const chunks = [];
process.stdout.write('ready\n');
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks));
const store = new ArtifactStore(input.cache);
if (input.kind === 'membership') await store.publishMembership(input.snapshot);
else await store.insert(input.result);
