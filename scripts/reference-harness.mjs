import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export function readReferenceSource(checkout, entry) {
  const bytes = readFileSync(resolve(checkout, entry.path));
  if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
    throw new Error('Modified reference source: ' + entry.path);
  }
  return bytes;
}

// The synchronous body owns this directory only until it returns or throws.
export function withReferenceDirectory(prefix, body) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  try { return body(directory); }
  finally { execFileSync('trash', [directory]); }
}

export function runReference(source, input, compilerArguments = []) {
  return withReferenceDirectory('mipmux-reference-', directory => {
    const program = join(directory, 'reference.swift'), executable = join(directory, 'reference');
    writeFileSync(program, source);
    execFileSync('swiftc', [...compilerArguments, program, '-o', executable], { stdio: 'inherit' });
    writeFileSync(join(directory, 'input.json'), input);
    const inputFile = openSync(join(directory, 'input.json'), 'r');
    try {
      const outputFile = openSync(join(directory, 'output.json'), 'w');
      try { execFileSync(executable, [], { stdio: [inputFile, outputFile, 'inherit'] }); }
      finally { closeSync(outputFile); }
    } finally { closeSync(inputFile); }
    return readFileSync(join(directory, 'output.json'));
  });
}
