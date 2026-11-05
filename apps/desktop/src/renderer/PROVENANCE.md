# Renderer provenance

Adapted from `opsique-mono-harness/apps/desktop/src/renderer` and its UI 0.1 contract on 2026-11-02. The project owner has authorized including this code in OpenBot's MIT-licensed public release.

Pure validation, state and formula modules live in `packages/shared/src/ui`; rendering remains in the desktop app. There is no runtime dependency or symlink to the source repository. Adaptations include local imports, the OpenBot neutral theme and host-owned action handling. The `opsique-ui/0.1` protocol name is retained for compatibility.
