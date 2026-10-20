import { resolve } from 'node:path';
import { BridgeClient } from '../../src/native/bridge-client.js';
import type { ProcessSupervisor } from '../../src/runtime/process-supervisor.js';
import type { DiscoveryPromptRenderer } from '../../src/context/discovery-input.js';

export function nativeDiscoveryRenderer(supervisor: ProcessSupervisor): DiscoveryPromptRenderer {
  return async (operation, signal) => {
    const bridge = new BridgeClient({ executable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`),
      env: {}, supervisor });
    try { return (await bridge.request(operation, signal)).result; }
    finally { await bridge.close(); }
  };
}
