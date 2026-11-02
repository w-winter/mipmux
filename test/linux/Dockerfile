FROM node:22.23.4-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS node
FROM swift:6.2-noble@sha256:29b983751c605c2d3102d2ab93438c6e0cadf110d9d2aa6e929b6dec9dcb7cbc
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
COPY ThirdPartyLicenses ThirdPartyLicenses
COPY LICENSE README.md THIRD_PARTY_NOTICES.md ./
RUN npm run build
CMD ["sh", "-c", "npm run verify:vendor && npm run typecheck && npm test"]
