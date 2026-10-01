# MerMarkd workspace rules

Read `docs/PRODUCT_ARCHITECTURE.md`, `docs/MODE_BOUNDARIES.md`, `docs/DEVELOPMENT_PROCESS.md`, and `docs/FEASIBILITY_REVIEW.md` before changing product behavior. Use `docs/PROGRESS.md` for the current phase and `docs/DECISIONS.md` for major architecture decisions. The user's latest request takes precedence over these files.

## Core invariants

- The `.md` file is the source of truth for content and heading structure. Card coordinates, fold state, viewport, and user arrows belong in companion state.
- Highlights, note bodies, tags, and their source anchors belong in the per-document `*.md.annotations.yaml` sidecar. They must never be inserted into Markdown merely to represent a reading annotation. An ambiguous anchor remains unresolved rather than attaching to different text.
- Moving a card on the canvas, folding, linking, and exporting must not change Markdown bytes. Only direct editing or an explicit, previewed change of chapter containment may change the source.
- Structural changes operate on source spans, reparse the candidate document, and reject unsafe transformations. Never stringify the whole Markdown AST to save a move.
- Markdown and companion state must remain recoverable across partial writes. Never silently overwrite external changes or attach a link to an ambiguously matched heading.
- Treat Markdown, annotation YAML, and canvas JSON as separately versioned files. Source-text changes that affect anchors must be mapped or flagged before any sidecar is committed against the new source hash.
- Export the full scene bounds, including arrows and labels. Detect and report size limits rather than clipping output.
- Reading mode shows the semantic result of supported Markdown and must not expose source markers, byte offsets, or raw anchor diagnostics in the normal reading flow. Editing mode shows the complete Markdown source and must not render it as rich text.
- Switching modes must not write Markdown or either sidecar. While an editor buffer is dirty, do not commit annotations or structural canvas changes against the persisted source hash.

## Development practice

- Work in small runnable slices. Prove installation, source transformations, persistence, nested canvas, and export in P0 before broad canvas UI work. Reader annotation UI may advance after its own source-anchor and sidecar gates pass; do not claim the P0 phase complete until all gates pass.
- Keep domain logic in `src/core` independent of Electron and React Flow. Use strict TypeScript and narrow preload IPC.
- Add focused tests for data mutations and export boundaries; run typecheck and relevant tests after changes. Verify the packaged app at each phase gate.
- Record completed work, commands, failures, and next steps in `docs/PROGRESS.md`. Record stack or data-model changes with rationale in `docs/DECISIONS.md`.
- Use npm and commit the lockfile until a documented decision changes the package manager. Keep dependency versions reproducible.
