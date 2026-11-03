# Building and publishing releases

The Release workflow builds a self-contained server archive for macOS arm64, Linux x64, and Linux arm64. Each archive includes compiled JavaScript, the native helper, production npm dependencies, license notices, an inventory, and a verification script. Users supply Node.js and Git 2.36 or later; they need neither a Swift toolchain nor an npm installation step.

The macOS helper targets macOS 14 or later and uses an ad-hoc signature. Linux builds use Swift 6.2 on Ubuntu 22.04 and statically link the Swift runtime. Linux hosts need glibc 2.35 or later and the standard C++ and GCC runtime libraries. The helper's linked-library inventory is recorded during packaging.

## Build and verify locally

From a configured source checkout with its build prerequisites installed:

```sh
npm ci
npm run package:release -- /absolute/path/to/new-release-output
```

Use a new output directory. The script builds the native helper and JavaScript, verifies source history, and installs production dependencies from the shipped `package-lock.json` with install scripts disabled. It writes `mipmux-<version>-<platform>-<arch>.tar.gz`, a matching `.sha256` file, and a matching `.inventory.json` file. The archive contains a directory with that same version and target in its name.

Extract the archive somewhere outside the checkout and run its verifier, replacing the example paths:

```sh
mkdir -p /absolute/path/to/install
tar -xzf /absolute/path/to/mipmux-0.1.0-alpha.1-darwin-arm64.tar.gz -C /absolute/path/to/install
package=/absolute/path/to/install/mipmux-0.1.0-alpha.1-darwin-arm64
node "$package/verify-release.mjs" "$package" /absolute/path/to/new-verification-output
```

The verifier uses synthetic source files and an explicit configuration, with discovery disabled. It checks the relocated CLI and library, native structure extraction and search, packet rendering, and integrity/current-source verification. It writes a receipt and packet artifacts to the verification directory. It makes no model calls and needs no credentials.

## Validate the workflow before tagging

Commit the release changes and merge them into `main` before creating a tag. Run the `Release` workflow manually from GitHub Actions or, as the repository owner:

```sh
gh workflow run release.yml --repo w-winter/mipmux --ref main
```

A manual run with the default inputs builds and tests all three targets and uploads archives, npm tarballs, and verification evidence as Actions artifacts. It creates no GitHub release and performs no npm publication or staging. Each Linux job also runs the extracted archive in a Node container with no Swift installation and networking disabled. The macOS job runs the relocated verifier and checks the helper's signature. After assembly, another check installs the same main npm tarball on all three targets using npm 12, exercising the CLI, library, MCP, and scripted discovery without provider credentials.

Inspect all three jobs and their saved verification receipts before tagging. Hosted validation is required for the platforms your local machine cannot exercise natively.

## Create the first prerelease

The server's first prerelease is `0.1.0-alpha.1`. The Pi and omp extensions have independent versions.

For each server version, update `package.json`, the root entries in `package-lock.json`, and the MCP software version in `src/mcp/server.ts`. The MCP initialization test checks that the advertised version matches the package.

Before publication, enable **release immutability** under **Releases** in the GitHub repository settings. Check the setting:

```sh
gh api repos/w-winter/mipmux/immutable-releases --jq .enabled
```

It must print `true`. Immutable releases lock their assets and tags when published, so inspect the draft before publishing it.

After the exact commit passes validation, the owner creates and pushes its version tag:

```sh
git tag v0.1.0-alpha.1
git push origin v0.1.0-alpha.1
```

The workflow requires the tag to equal `v` followed by `package.json`'s version. It builds all targets, assembles the npm server package from the verified platform helpers, checks the release files, creates GitHub build attestations for the archives and npm tarballs, and opens a draft release with those artifacts and their inventories. Tags containing a prerelease suffix produce a prerelease draft. Building jobs have read-only repository permission; the final job alone can attest artifacts and create the draft.

Review the draft, confirm immutability is enabled, and publish it:

```sh
gh release edit v0.1.0-alpha.1 --repo w-winter/mipmux --draft=false
```

The workflow stops at the draft. It does not publish the release on your behalf. A failed run should be diagnosed before retrying; an existing draft is not overwritten automatically.

## Download and verify a published archive

Choose a version and target from the [release list](https://github.com/w-winter/mipmux/releases). For example, after `v0.1.0-alpha.1` is published:

```sh
gh release download v0.1.0-alpha.1 --repo w-winter/mipmux \
  --pattern 'mipmux-0.1.0-alpha.1-darwin-arm64.tar.gz'
gh release verify v0.1.0-alpha.1 --repo w-winter/mipmux
gh release verify-asset v0.1.0-alpha.1 ./mipmux-0.1.0-alpha.1-darwin-arm64.tar.gz \
  --repo w-winter/mipmux
gh attestation verify ./mipmux-0.1.0-alpha.1-darwin-arm64.tar.gz --repo w-winter/mipmux
```

Use a current GitHub CLI with release and artifact verification support. Release verification checks GitHub's immutable-release record; the build attestation identifies the workflow and source commit that produced the bytes. A checksum file alone does not authenticate its source.

On macOS, use `gh release download` rather than a browser download. The first release uses ad-hoc signing, not Apple notarization; browser downloads can receive a quarantine attribute that prevents the helper from running.

Extract the verified archive and configure your MCP client to run:

```text
node /absolute/path/to/mipmux-0.1.0-alpha.1-darwin-arm64/dist/cli/main.js mcp
```

Use the matching Linux directory name for a Linux archive. Configure discovery through the [configuration guide](https://github.com/w-winter/mipmux/blob/main/docs/configuration.md). To use Claude Code discovery, install the exact optional SDK version documented there into the extracted package; Pi-based discovery uses the dependencies already included.

The Pi and omp extensions also need a `mipmux` command on `PATH`. Link the archive's executable into a directory on your path, for example:

```sh
mkdir -p "$HOME/.local/bin"
ln -s /absolute/path/to/mipmux-0.1.0-alpha.1-darwin-arm64/dist/cli/main.js "$HOME/.local/bin/mipmux"
```

Ensure `$HOME/.local/bin` is on your shell's `PATH`. The link command refuses to replace an existing installation.

## Install from npm

Once a version is published, install the server with an exact version:

```sh
npm install --global --ignore-scripts mipmux@0.1.0-alpha.1
mipmux config
```

Configure discovery using the [configuration guide](configuration.md), then configure your MCP client to run `mipmux mcp`. For a one-command invocation through npm:

```sh
npm_config_ignore_scripts=true npx --yes mipmux@0.1.0-alpha.1 mcp
```

The installation supports macOS arm64, Linux x64, and Linux arm64. Linux requires glibc 2.35 or later. The server resolves its matching `@w-winter/mipmux-<platform>-<arch>` helper automatically; users install `mipmux`, rather than choosing a helper manually. Keep optional dependencies enabled. A `nativeHelperUnavailable` error means the helper package cannot be resolved; reinstall with optional dependencies included, for example `npm install --global --ignore-scripts --include=optional mipmux@0.1.0-alpha.1`.

The main npm tarball bundles the production JavaScript dependencies installed from the build's lockfile. Native helpers remain separate optional dependencies pinned to the server's exact version. The packages have no lifecycle scripts. The explicit `--ignore-scripts` also disables scripts declared by transitive dependencies.

For Pi-based discovery using a provider login, start the bundled Pi CLI after a global installation:

```sh
node "$(npm root -g)/mipmux/node_modules/.bin/pi"
```

Run `/login`, choose the provider, and quit Pi. The [source quickstart](../README.md#quickstart) describes the discovery configuration; API-key and Claude Code discovery use their own configuration instructions.

## Build npm tarballs

Each platform job creates a helper from its extracted, verified archive:

Use a new output directory whose parent already exists. The packager refuses an existing output directory before writing artifacts.

```sh
node scripts/package-npm.mjs helper /absolute/extracted-package /absolute/smoke/receipt.json /absolute/npm-output
```

The helper names are `@w-winter/mipmux-darwin-arm64`, `@w-winter/mipmux-linux-x64`, and `@w-winter/mipmux-linux-arm64`. Each helper contains its native executable and notices, and declares its supported operating system and CPU. It has the same version as the main package.

After collecting all three helper tarballs and their adjacent inventories, assemble the main package:

```sh
node scripts/package-npm.mjs main \
  /absolute/extracted-package /absolute/smoke/receipt.json /absolute/npm-output \
  /absolute/helpers/w-winter-mipmux-darwin-arm64-0.1.0-alpha.1.tgz \
  /absolute/helpers/w-winter-mipmux-linux-x64-0.1.0-alpha.1.tgz \
  /absolute/helpers/w-winter-mipmux-linux-arm64-0.1.0-alpha.1.tgz
```

The assembler checks the source inventory and smoke receipt, requires one helper for each target, and checks their versions and identities. The main tarball contains the JavaScript server and its locked production dependency tree, declared through `bundleDependencies`; the native helpers are exact-version optional dependencies. The adjacent inventories record the tarballs' SHA-512 integrity values. Source checkouts remain private npm packages; publish only the generated tarballs.

## Publish the initial npm versions

The first version of each package must be published by the owner before npm allows a trusted publisher to be configured. Download the four `.tgz` files from the verified GitHub release. Check each with `gh release verify-asset` and `gh attestation verify`, as for the server archives, before publishing.

Publish the helpers first, then the main package. These commands require your npm login and 2FA:

```sh
npm publish ./w-winter-mipmux-darwin-arm64-0.1.0-alpha.1.tgz --access public --tag next --ignore-scripts
npm publish ./w-winter-mipmux-linux-x64-0.1.0-alpha.1.tgz --access public --tag next --ignore-scripts
npm publish ./w-winter-mipmux-linux-arm64-0.1.0-alpha.1.tgz --access public --tag next --ignore-scripts
npm publish ./mipmux-0.1.0-alpha.1.tgz --access public --tag next --ignore-scripts
```

If publication stops partway through, inspect which versions reached npm and publish only the remaining packages. npm versions are immutable; do not rebuild different bytes under a version already published.

## Configure trusted staging

After all four packages exist, configure each to trust this repository's `release.yml` workflow for staging only:

```sh
for package in mipmux @w-winter/mipmux-darwin-arm64 @w-winter/mipmux-linux-x64 @w-winter/mipmux-linux-arm64; do
  npm trust github "$package" --repo w-winter/mipmux --file release.yml --allow-stage-publish
done
```

In each package's npm publishing-access settings, require two-factor authentication and disallow tokens. Configure trust close to its first use: an unvalidated trusted-publisher configuration expires after two days. Do not grant direct publication or dist-tag management to the workflow.

## Stage later npm versions

After publishing and verifying a later immutable GitHub release, dispatch the workflow on that tag with `stage_npm=true`:

```sh
gh workflow run release.yml --repo w-winter/mipmux --ref v0.1.0-alpha.2 -f stage_npm=true
```

Replace the example tag with the published version. This operation checks the immutable release and each tarball's build attestation against the selected tag and commit, then calls `npm stage publish` using GitHub OIDC. It downloads the published bytes rather than rebuilding them. Prereleases use the `next` dist-tag; stable versions use `latest`. The staging job has no repository-write permission and needs no npm token. Node 24.22.1 supplies npm 11.19.1, which supports staged publishing.

Inspect and approve each returned npm stage ID with your own 2FA:

```sh
npm stage view <stage-id>
npm stage download <stage-id>
npm stage approve <stage-id>
```

Approve the helper stages before the main package. The workflow creates pending stages; only the owner's approval publishes them.
