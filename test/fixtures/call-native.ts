import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { nativeFrameValidator, type NativeOperation } from '../../src/contracts/native.js';

export function callNative(operation: NativeOperation, generation: string, requestId: string) {
  const child = spawnSync(resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`), [generation], {
    input: JSON.stringify({ wireVersion: 1, requestId, generation, operation }) + '\n', encoding: 'utf8',
  });
  if (child.error) throw child.error;
  assert.equal(child.status, 0, requestId + ': ' + child.stderr);
  const frames = child.stdout.trim().split('\n');
  assert.equal(frames.length, 1, 'Native stdout must contain exactly one frame');
  const value: unknown = JSON.parse(frames[0]!);
  const frame = nativeFrameValidator.Parse(value);
  assert(frame.kind === 'terminal', 'Native stdout must contain a terminal frame');
  assert.equal(frame.generation, generation);
  assert.equal(frame.requestId, requestId);
  return frame;
}
