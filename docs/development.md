# Building and testing

Contributors, and anyone building mipmux beyond the [quickstart](../README.md#quickstart), find here how the parts fit together, the full build and test sequence, the native helper, local packages and the Linux validation image. [Native and workspace contracts](contracts.md) is the exhaustive reference for the internal interfaces.

## How mipmux is built

Swift owns extraction and descriptor-relative filesystem access. TypeScript owns workspace policy, inventory generations, persistent artifacts, drafts, Git comparisons, rendering, and verification. An isolated Pi discovery agent can curate a draft through scoped tools, called directly or from Pi `codemode` scripts, before the parent verifies and publishes it.

## Build and test

Install the [requirements](../README.md#requirements), then run the full build and test sequence below. The build downloads the pinned PCRE2 10.49 archive, verifies its checksum and packaged SLJIT files, builds its static width-8 library, and runs upstream tests. SwiftPM dependencies are pinned in `native/Package.resolved`. npm dependencies are pinned in `package-lock.json`, and the repository's `.npmrc` sets `ignore-scripts=true`, so `npm ci` runs none of their install scripts; mipmux does not need them.

```sh
npm ci
node scripts/build-native.mjs test
npm run verify:vendor
npm run typecheck
npm run build
node scripts/build-native.mjs build --configuration release
npm test
```

Run native commands through `scripts/build-native.mjs`. It supplies SwiftPM's explicit `--pkg-config-path`, verifies the private dependency files, checks the linked executable, and writes `linkage.json` beside the executable. A mismatched or interrupted dependency build fails with its directory path for inspection and explicit removal before rebuilding.

Search uses the native executable's Foundation and statically linked PCRE2 matching implementations. The native dependency receipt and linkage checks identify the engine used by both extraction and search.

The native executable is `native/.build/<platform>-<architecture>/<configuration>/MipmuxBridge`, with Node's platform and architecture names, such as `darwin-arm64` and `linux-arm64`. Its first argument is a process-generation identifier. Requests and responses use JSON Lines on stdin/stdout; each request includes that generation, wire version 1, and a request ID.

Release builds also copy the verified executable to `libexec/<platform>-<architecture>/MipmuxBridge`. Native filesystem tests retain synthetic files beneath the excluded `test-output/` directory for inspection.

```sh
target="$(node -p 'process.platform + "-" + process.arch')"
printf '%s\n' '{"wireVersion":1,"requestId":"describe","generation":"example","operation":{"kind":"describe"}}' |
  "native/.build/$target/debug/MipmuxBridge" example
```

`describe` reports supported extensions, extraction limits, decoder policy, regex-engine checks, and Swift's canonical pipeline identities. [The native contract](contracts.md) describes acquisition, extraction, export, and cancellation.

## Local package

Create an unpublished package in an absolute output directory:

```sh
npm run package:local -- /var/tmp/mipmux-local-package
```

The command builds TypeScript and the native release executable, verifies source history, and packs the runtime files and notices through npm. `inventory.json` records archive and file hashes, sizes, `buildLockSHA256`, and the packaged executable's linked libraries. That digest identifies the package-lock.json used to build mipmux; installed dependency graphs have their own lockfiles and audit results. Release copies omit debug metadata and use portable compiler source paths. The native build directory retains the unstripped executable and its linkage receipt.

Install the resulting `.tgz` with `npm install --ignore-scripts /absolute/path/mipmux-0.1.0.tgz`. The installed CLI is available as `mipmux`. It runs the package's own `libexec/<platform>-<architecture>/MipmuxBridge` unless the configuration names another `nativeExecutable`. The package includes the discovery prompt and dependency identity beside its compiled modules.

## Linux validation and runtime

```sh
docker build -f test/linux/Dockerfile -t mipmux-validation .
docker run --rm mipmux-validation
```

The image for validation fixes Swift 6.2.4 on Ubuntu Noble and Node 22.23.4 by image digest. It builds dependencies and executables inside Linux. The release executable dynamically requires the Swift runtime, Foundation, Dispatch, Foundation ICU, glibc, libstdc++, and libgcc supplied by that environment. The exact linked-library inventory is in `linkage.json`; PCRE2 is statically linked. A machine running the executable must supply those runtime libraries.

## Source history

The extractor derives from RepoPrompt CE revision `64b9352eec13e0252500d429f64ca9d1dd5e49fd`. `docs/vendor-provenance.json` records original hashes, retained destinations, moved declaration ranges, and adaptations. `npm run verify:vendor` checks the hashes of retained files, dependency pins, generated metadata, notices, and the 1,000-line ceiling for handwritten code. After editing a file listed there, update its `sha256` and add a note to its `changes`.
