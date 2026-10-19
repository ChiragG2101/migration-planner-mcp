# Vendored Python grammar

`tree-sitter-python.wasm` is the prebuilt WebAssembly grammar from the npm package `tree-sitter-python` **0.25.0** (MIT, see `LICENSE`), copied as is. It is vendored because the package's install step runs `node-gyp-build` for its native binding, which the engine never uses; the engine loads only this file through `web-tree-sitter` (`docs/design.md` D26).

- Source: https://registry.npmjs.org/tree-sitter-python/-/tree-sitter-python-0.25.0.tgz (`package/tree-sitter-python.wasm`)
- sha256: `16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47`
- Grammar ABI: 15, loaded by `web-tree-sitter` 0.27.1

`test/unit/lang/python.test.ts` checks the checksum. To upgrade: copy the `.wasm` from the new package version, update the version and checksum here and in the test, and run the Python adapter tests.
