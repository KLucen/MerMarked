# MerMarkd workspace rules

Read `docs/PRODUCT_ARCHITECTURE.md`, `docs/DEVELOPMENT_PROCESS.md`, and `docs/FEASIBILITY_REVIEW.md` before changing product behavior. Use `docs/PROGRESS.md` for the current phase and `docs/DECISIONS.md` for major architecture decisions. The user's latest request takes precedence over these files.

## Core invariants

- The `.md` file is the source of truth for content and heading structure. Card coordinates, fold state, viewport, and user arrows belong in companion state.
- Moving a card on the canvas, folding, linking, and exporting must not change Markdown bytes. Only direct editing or an explicit, previewed change of chapter containment may change the source.
- Structural changes operate on source spans, reparse the candidate document, and reject unsafe transformations. Never stringify the whole Markdown AST to save a move.
- Markdown and companion state must remain recoverable across partial writes. Never silently overwrite external changes or attach a link to an ambiguously matched heading.
- Export the full scene bounds, including arrows and labels. Detect and report size limits rather than clipping output.

## Development practice

- Work in small runnable slices. Prove installation, source transformations, persistence, nested canvas, and export in P0 before broad UI work.
- Keep domain logic in `src/core` independent of Electron and React Flow. Use strict TypeScript and narrow preload IPC.
- Add focused tests for data mutations and export boundaries; run typecheck and relevant tests after changes. Verify the packaged app at each phase gate.
- Record completed work, commands, failures, and next steps in `docs/PROGRESS.md`. Record stack or data-model changes with rationale in `docs/DECISIONS.md`.
- Use npm and commit the lockfile until a documented decision changes the package manager. Keep dependency versions reproducible.
