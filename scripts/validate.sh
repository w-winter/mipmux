#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
npm ci --ignore-scripts
npm audit
node scripts/build-native.mjs test
node test/linux/setup-search.mjs
npm run verify:vendor
npm run typecheck
npm run build
node scripts/build-native.mjs build --configuration release
npm test
