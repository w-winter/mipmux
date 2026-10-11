# Third-party notices

The Swift extractor, regex wrapper, C wrapper, and retained tests derive from [RepoPrompt CE](https://github.com/repoprompt/repoprompt-ce) revision `64b9352eec13e0252500d429f64ca9d1dd5e49fd`, licensed under Apache-2.0. The license is in `ThirdPartyLicenses/repoprompt-ce/LICENSE`. Modified files carry change notices, and `docs/vendor-provenance.json` records their source history.

The native discovery prompt factory, discovery prompt and rendered references derive from RepoPrompt CE revision `43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3` under the same license. [Discovery prompt bindings](docs/discovery-prompt-bindings.md) records the rendering inputs and adaptations to smip's interfaces.

PCRE2 10.49 is statically linked under BSD-3-Clause WITH PCRE2-exception. Its pinned SLJIT dependency uses BSD-2-Clause. Their complete texts are in `ThirdPartyLicenses/pcre2/LICENCE.md` and `ThirdPartyLicenses/sljit/LICENSE`.

SwiftTreeSitter, the Tree-sitter runtime, and the twelve grammar packages have license copies in their named directories under `ThirdPartyLicenses/`. The JavaScript/Python scanner snapshots and accompanying headers match the pinned grammar sources. `ThirdPartyLicenses/tree-sitter/ICU-LICENSE` contains the runtime's bundled Unicode/ICU notice.

Swift Crypto 4.5.1 and its resolved Swift ASN.1 dependency have Apache-2.0 licenses and notices in `ThirdPartyLicenses/swift-crypto/` and `ThirdPartyLicenses/swift-asn1/`. The Linux crypto build includes BoringSSL-derived source identified by Swift Crypto's `Sources/CCryptoBoringSSL/hash.txt`; its Apache-2.0 license at revision `0226f30467f540a3f62ef48d453f93927da199b6` is in `ThirdPartyLicenses/boringssl/LICENSE`.

TypeBox 1.3.27 uses the MIT license, copied to `ThirdPartyLicenses/typebox/LICENSE`. `ThirdPartyLicenses/inventory.json` records the origin and SHA-256 of every copied license or notice. Operating-system and Swift runtime libraries remain separately installed runtime requirements.

The `ignore` 7.0.12 dependency evaluates repository-local ignore rules under the MIT license, copied to `ThirdPartyLicenses/ignore/LICENSE-MIT`.

Pi coding-agent, AI and agent-core 1.0.2 run isolated discovery sessions under the MIT license. Their upstream license at revision `cd32f7725fdbddbaecdff5b1e68491563394e0ca` is copied to `ThirdPartyLicenses/pi/LICENSE`. Pi provides the session, model transport and same-model recovery APIs; the parent smip process retains filesystem and publication authority.

The Model Context Protocol server and client 2.3.0 use Apache-2.0, copied to `ThirdPartyLicenses/mcp/LICENSE`. The server supplies stdio negotiation, schema-based tool registration and request cancellation; the client is a test dependency for interoperability checks. Resolved dependencies are identified in the npm lockfile and retain their respective notices in their packages.

The selection input parser retains JSON value and data-URL decoding from RPCE's pinned Swift MCP SDK revision `5716de85a976a8f70dedc9cb000e50aaa0d8cc5b`. These functions preserve the reference parser's typed numeric/string access and data-URL classification. The upstream mixed Apache-2.0/MIT licensing notice is copied to `ThirdPartyLicenses/swift-mcp/LICENSE`; source ranges and adaptations are recorded in `docs/vendor-provenance.json`.

The native ignore compiler and rule snapshots derive from RepoPrompt CE revision `43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3`. Their bundled wildmatch implementation and header retain their separate BSD notices in `ThirdPartyLicenses/wildmatch/`. This product includes software developed by the University of California, Berkeley and its contributors.
