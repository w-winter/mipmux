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

`npm test` sets a 20-minute timeout for tests. Node can enforce this timeout only while the test's event loop is running. CI also limits the macOS test step and Linux validation step to 40 minutes. Package verification gives each discovery job wait and CLI build two minutes, and uses the same limit when installing from its local test registry. MCP server diagnostics go to stderr. Failed job waits report the job ID, last reply and underlying error.

After `npm test` has compiled the tests, rerun the package checks with `node --test --test-timeout=1200000 dist-test/test/package-local.test.js dist-test/test/package-wait.test.js`. The tests in `test/package-wait.test.ts` save their failure diagnostics in `test-output/package-wait-*.json`.

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

Each client folder under `workflow-examples/` is a complete copy that users install on its own. The role instructions, and each skill outside its **Host mechanics** section, must read the same in every folder, so change all five copies together; `test/workflow-examples.test.ts` fails when one differs.

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

## Continuous integration

The CI workflow runs for pull requests and for pushes to `main`. Version tags run the Release workflow instead, which builds and tests all three release targets.

Each run starts with **Route changes**. It runs `npm run verify:vendor`, so a stale hash in `docs/vendor-provenance.json` fails the run within a minute, and it runs `scripts/ci-lanes.mjs` to choose the other jobs from the paths that changed since a base commit. For a push, the base is the previous tip of `main`. For a pull request, CI tests GitHub's merge commit, and the base is that commit's first parent, the `main` commit the pull request was merged into. The script lists added, modified, deleted and type-changed paths, and counts a rename as a deletion plus an addition.

| Changed paths | Jobs |
| --- | --- |
| Markdown under `docs/`, `CHANGELOG.md`, `SECURITY.md`, `docs/vendor-provenance.json`, and edits to an integration's `README.md` or `CHANGELOG.md` | None beyond Route changes |
| `workflow-examples/` | Workflow examples: compiles the tests and runs `test/workflow-examples.test.ts`, without the native helper |
| Other files under `integrations/pi/` or `integrations/omp/` | Pi and oh-my-pi extensions on macOS arm64; both run, because oh-my-pi copies the Pi sources and uses a Pi test fixture |
| Anything else, including the root `README.md`, whose content package staging checks, and any type change, such as a file replaced by a symlink | The full pipeline: the Linux and macOS jobs and both extensions |

A run uses fewer jobs only when the base commit already has a successful CI run for a push to `main`. When that run is missing, still running, failed or was cancelled, when the base commit is not in the checkout, or when GitHub cannot be queried, the run uses the full pipeline. The Route changes log lists every changed path with its rule and each reason for a full run.

The final **CI** job passes when every job the change requires succeeded and every other job was skipped. Each pull request keeps only its newest run. Runs for pushes to `main` are never cancelled, so each commit on `main` gets a result that later runs can use as their base.

To preview a selection, run `node scripts/ci-lanes.mjs <base> <head>` in a checkout that contains both commits. The script prints the job flags on stdout and its reasoning on stderr. The base check calls an authenticated `gh`, which finds the repository from the `origin` remote or from `GH_REPO=w-winter/mipmux`. For a branch, use `node scripts/ci-lanes.mjs "$(git merge-base origin/main HEAD)" HEAD`.

Paths that no rule covers use the full pipeline. When a build step, test or packaging script starts reading a file that a narrower rule covers, change the rule in `scripts/ci-lanes.mjs` and its cases in `test/ci-lanes.test.ts`.

## Source history

The extractor derives from RepoPrompt CE revision `64b9352eec13e0252500d429f64ca9d1dd5e49fd`. `docs/vendor-provenance.json` records original hashes, retained destinations, moved declaration ranges, and adaptations. `npm run verify:vendor` checks the hashes of retained files, dependency pins, generated metadata, notices, and the 1,000-line ceiling for handwritten code. After editing a file listed there, update its `sha256` and add a note to its `changes`.
