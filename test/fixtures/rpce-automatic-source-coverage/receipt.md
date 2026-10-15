# Automatic source coverage fixtures

These 13 fixtures execute RPCE's original selected-source classification, source-issue mapping, root-status conditional and coverage aggregation at revision `43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3`. `provenance.json` identifies each original file, Git blob and retained range. `adapter.swift` supplies deterministic identities, current unfenced slots and already-counted targets. `expected.json` records the original outputs, including excluded-only roots with `ok` status and the omission of aggregate issues when all roots are `ok`.

Formatted adapter declarations and scoped SwiftLint directives surround verbatim source excerpts. The generator verifies each original range before compiling it and records the wrapper and output hashes separately.

On macOS, regenerate with `node test/fixtures/rpce-automatic-source-coverage/generate.mjs /absolute/path/to/repoprompt-ce`. Append `--check` to verify byte-for-byte reproduction. Use the pinned revision with its relevant files unchanged. Generation requires Node, Swift and `trash`; the original Darwin ordering helper requires macOS. The TypeScript conformance test consumes the saved outputs on macOS and Linux.

The fixtures establish classification and aggregation for the declared inputs. They do not establish matching, budgets, epochs, currentness, receipt validation, demand readiness or filesystem behavior. Pending and unavailable graph roots are supplied aggregate inputs. The TypeScript comparison checks root status and aggregate source issues; the existing structural-query assertion separately checks that a useful target survives a mixed-root result. It does not compare graph issues reported at the root level.
