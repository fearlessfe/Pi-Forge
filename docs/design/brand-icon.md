# Pi Forge product icon

![Pi Forge application icon](../../apps/desktop/build/icon.svg)

## Concept

The mark is a forged, modular **π** rather than a typeset character:

- the wide upper billet represents the stable runtime and interface layer;
- the two lower billets represent interchangeable brains and hands;
- the open negative space keeps the system extensible rather than closed;
- the blue rivet is an observable runtime node: small, active, and controlled;
- the dark grid field connects the icon to developer tooling without turning it into a terminal cliché.

The geometry is intentionally reduced so the mark remains recognizable at 16 px and does not depend on text.

## Palette

| Role | Color | Meaning |
| --- | --- | --- |
| Forge mint | `#7BF1A8` | construction, openness, forward motion |
| Active blue | `#73A9FF` | events, execution, observability |
| Carbon | `#090C11` | dependable technical foundation |
| Steel | `#33404D` | boundaries and structure |

## Usage

- Use the complete dark tile for application icons, social avatars, and release artwork.
- Use the simplified billet mark inside the product UI at small sizes.
- Keep the symbol upright and preserve at least 12.5% clear space around it.
- Do not typeset a substitute π, recolor individual billets, add extra sparks, or place the mark on a busy image.

## Source assets

- `apps/desktop/build/icon.svg` — editable vector source and canonical master
- `apps/desktop/build/icon.png` — 1024 × 1024 cross-platform packaging source

Electron Builder derives platform-specific macOS and Windows icon containers from the PNG during packaging.
