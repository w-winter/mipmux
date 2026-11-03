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

Application builds run TypeScript in single-threaded mode so generated type declarations have consistent union-member ordering across builds. Release packaging compares the complete application output across platforms. `npm run typecheck` uses the compiler's parallel mode.

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

The command builds TypeScript and the native release executable, verifies source history, and creates a tar archive of runtime files, notices, and the build's `package-lock.json`. `inventory.json` records archive and file hashes, sizes, `buildLockSHA256`, and the packaged executable's linked libraries. Release copies omit debug metadata and use portable compiler source paths. The native build directory retains the unstripped executable and its linkage receipt.

Extract the resulting `.tgz` and install its production dependencies from the lockfile. Use a new installation directory:

```sh
mkdir -p /absolute/path/to/install
tar -xzf /absolute/path/to/mipmux-0.1.0-alpha.1.tgz -C /absolute/path/to/install
cd /absolute/path/to/install/package
npm ci --omit=dev --ignore-scripts
node dist/cli/main.js mcp
```

The CLI runs the package's own `libexec/<platform>-<architecture>/MipmuxBridge` unless the configuration names another `nativeExecutable`. The package includes the discovery prompt and dependency identity beside its compiled modules. For an archive with production dependencies already installed, use [release packaging](releases.md).

## Linux validation and runtime

```sh
docker build -f test/linux/Dockerfile -t mipmux-validation .
docker run --rm mipmux-validation
```

The validation image pins Swift 6.2.4 on Ubuntu 22.04 and Node 22.23.4 by image digest. It builds dependencies and executables inside Linux, then runs the release helper in a separate Ubuntu 22.04 image with no Swift installation. Debug builds and native tests use the toolchain's dynamic Swift libraries. For the application tests, the image builds Git 2.56.0 from its checksum-pinned source archive; mipmux uses the NUL-delimited worktree listing introduced in Git 2.36.

Linux release builds use `--static-swift-stdlib` to include the Swift runtime, Foundation, Dispatch, and ICU. PCRE2 is also statically linked. The host supplies glibc, libstdc++, and libgcc. Release checks reject dynamic Swift libraries and glibc symbol requirements above 2.35; use the pinned Docker image to build against this baseline. `linkage.json` records the linked libraries and required glibc symbol versions.

## Source history

The extractor derives from RepoPrompt CE revision `64b9352eec13e0252500d429f64ca9d1dd5e49fd`. `docs/vendor-provenance.json` records original hashes, retained destinations, moved declaration ranges, and adaptations. `npm run verify:vendor` checks the hashes of retained files, dependency pins, generated metadata, notices, and the 1,000-line ceiling for handwritten code. After editing a file listed there, update its `sha256` and add a note to its `changes`.
