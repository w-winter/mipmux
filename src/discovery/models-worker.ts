import { WorkspaceFailure } from '../workspace/values.js';
import { listDiscoveryModels } from './discovery-models.js';
import { modelsRequestValidator } from './pi-protocol.js';
import { receive, send } from './pi-channel.js';

// Lists discovery's models in the environment PiRunner gives the discovery worker, so the list matches what discovery can use.
const controller = new AbortController();
const fail = () => { controller.abort(); process.exitCode = 1; process.stdin.destroy(); };
process.on('SIGTERM', () => controller.abort());
receive(process.stdin, value => {
  if (!modelsRequestValidator.Check(value)) throw new Error('Invalid models request');
  void listDiscoveryModels(value.config, controller.signal).then(
    models => send(process.stdout, { kind: 'models', models }),
    error => {
      if (!(error instanceof WorkspaceFailure)) throw error;
      send(process.stdout, { kind: 'failed', code: error.code });
    }).then(() => process.stdin.destroy(), fail);
}, fail);
