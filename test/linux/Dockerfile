FROM node:22.23.4-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS node
FROM swift:6.2-jammy@sha256:7889980d84f47447d109990a6763f3a7997acf2d1059bbd7c56f7e0af6243f73 AS validation-build
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake pkg-config
WORKDIR /validation/mipmux-source
COPY native/pcre2-recipe.json native/pcre2-recipe.json
COPY scripts/build-native.mjs scripts/build-native.mjs
RUN node scripts/build-native.mjs dependency
COPY native native
COPY docs/vendor-provenance.json docs/vendor-provenance.json
RUN node scripts/build-native.mjs test && node scripts/build-native.mjs build --configuration release
COPY package.json package-lock.json tsconfig.json tsconfig.test.json ./
RUN npm ci --ignore-scripts
COPY src src
COPY test test
COPY scripts scripts
COPY prompts prompts
COPY workflow-examples workflow-examples
COPY ThirdPartyLicenses ThirdPartyLicenses
COPY LICENSE README.md THIRD_PARTY_NOTICES.md ./
RUN npm run build

FROM ubuntu:22.04@sha256:076e7bf82319619f28dd0aa9c02ab34b055ad37100395b4f49a2ffba04fb5e11 AS runtime-check
COPY --from=validation-build /validation/mipmux-source/libexec /opt/mipmux/libexec
RUN ! command -v swift && printf '%s\n' '{"wireVersion":1,"requestId":"describe","generation":"runtime-check","operation":{"kind":"describe"}}' | \
    /opt/mipmux/libexec/linux-*/MipmuxBridge runtime-check > /runtime-description.json

FROM validation-build AS validation
ADD --checksum=sha256:26c56c296b38c0695b26fa95f475f1d01704d2d38e73465ca30b0b2f5dc789d3 https://www.kernel.org/pub/software/scm/git/git-2.56.0.tar.xz /tmp/git.tar.xz
# Jammy's Git predates the NUL-delimited worktree listing used by mipmux.
RUN apt-get update && apt-get install -y --no-install-recommends gettext libssl-dev && \
    tar -xJf /tmp/git.tar.xz -C /tmp && \
    make -C /tmp/git-2.56.0 -j"$(nproc)" prefix=/usr NO_TCLTK=YesPlease NO_RUST=YesPlease install && git --version
COPY --from=runtime-check /runtime-description.json /validation/runtime-description.json
RUN node -e 'const assert = require("node:assert/strict"); const description = require("/validation/runtime-description.json"); assert.equal(description.result.kind, "description"); assert.equal(description.result.engine.jitExecution, "compiled");'
CMD ["sh", "-c", "npm run verify:vendor && npm run typecheck && npm test"]
