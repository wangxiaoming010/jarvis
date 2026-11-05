# Third-party notices

OpenBot's original code is released under the [MIT License](LICENSE).

The dynamic renderer and UI 0.1 contract were adapted from
`opsique-mono-harness` with the project owner's authorization to include them
in this MIT-licensed release. See the [renderer provenance](apps/desktop/src/renderer/PROVENANCE.md).
The `opsique-ui/0.1` identifier is retained for protocol compatibility.

JavaScript and Rust dependencies retain their own licenses. Their exact versions
are recorded in `package-lock.json` and `apps/desktop/src-tauri/Cargo.lock`.
Installing dependencies does not change those licenses.

Desktop packages include Node.js and native SQLite dependencies. The runtime
build includes Node.js's license, dependency notices and the licenses of copied
native modules. Frontend dependency notices are generated alongside the web assets.

Codex CLI, Claude Code and model APIs are external integrations; their executables,
accounts and credentials are not included in this source release. Example URLs in
UI fixtures refer to external services and do not grant rights to their content.

The Codex and Claude SVG marks in `apps/desktop/public/logos/` are from
[LobeHub Icons](https://github.com/lobehub/lobe-icons), under the MIT License.
Their copyright and license are included in `apps/desktop/public/logos/LICENSE.txt`
and distributed with the frontend assets. Brand names and marks belong to their
respective owners.
