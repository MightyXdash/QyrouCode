# SupraCode AGENTS.md

This file defines conventions, design system, and workflow rules for SupraCode. AI agents should follow these instructions when working on this codebase.

---

## SupraCode Design System

### Visual Theme Overview

SupraCode features a minimal, low-contrast design system with intentional restraint. The default theme prioritizes clarity and accessibility through carefully calibrated color hierarchies rather than bold visual separations.

### Typography

- **Primary font**: `DM Sans` (Google Fonts) — geometric, soft terminals, consistent x-height
- **Code font**: `JetBrains Mono` or `Geist Mono` — for code blocks and monospace
- Use variable font weights (400, 500, 600) for flexibility
- Line height: `1.5` for body, `1.2` for headings

### Corner Radius

Minimal border-radius with precise increments:
- `--radius-xs: 0.125rem` (1px)
- `--radius-sm: 0.25rem` (2px)
- `--radius-md: 0.375rem` (3px)
- `--radius-lg: 0.5rem` (4px)
- `--radius-xl: 0.625rem` (5px)

These small values create an understated, modern aesthetic without prominent curves. Structure is defined through color and layering rather than aggressive geometric shapes.

### Shadow & Elevation System

Subtle depth with fine-grained layering:
- `--shadow-xs`: Minimal elevation for inline elements
- `--shadow-md`: Medium floating elements
- `--shadow-lg`: Large modals and overlays
- Border shadows maintain hairline precision at `0.5px` stroke weight

Use `light-dark()` CSS notation for semantic mode switching.

### Animations

- **Pop-up menus/overlays**: Start from a larger scale and animate down to intended size with an ease-out timing function (e.g., `transform: scale(1.05) -> scale(1)` with `ease-out`).
- Keep animations subtle and fast (< 200ms) for a snappy feel.

### Light Mode Colors

**Base Palette:**
- Background: `#f7f7f7`
- Surface Raised: `#f3f3f3` to `#ffffff`
- Primary/Accent: `#dcde8d` (muted lime-gold)
- Interactive: `#034cff` (saturated blue)
- Success: `#12c905`
- Warning: `#ffdc17`
- Error: `#fc533a`
- Info: `#a753ae`

**Text Hierarchy:**
- `--text-strong: #171717`
- `--text-base: #6f6f6f`
- `--text-weak: #8f8f8f`
- `--text-weaker: #c7c7c7`

**Border Tones:**
- `--border-base: rgba(0, 0, 0, 0.162)`
- `--border-weak-base: #dbdbdb`
- `--border-strong-base: rgba(0, 0, 0, 0.151)`

### Dark Mode Colors

**Base Palette:**
- Background: `#1f1f1f`
- Surface Raised: `#232323` to `#282828`
- Primary/Accent: `#fab283` (warm orange-tan)
- Interactive: `#034cff`
- Success: `#12c905`
- Warning: `#fcd53a`
- Error: `#fc533a`
- Info: `#edb2f1`

**Text Hierarchy:**
- `--text-strong: #ededed`
- `--text-base: #a0a0a0`
- `--text-weak: #707070`
- `--text-weaker: #505050`

**Border Tones:**
- `--border-base: rgba(255, 255, 255, 0.195)`
- `--border-weak-base: #282828`
- `--border-strong-base: rgba(255, 255, 255, 0.266)`

### Design Principles

- **Minimal structure**: Subtle border-radius, no aggressive geometry
- **Low contrast hierarchy**: Gray scale + reserved saturated accent
- **Transparent surfaces**: Layering via alpha overlays, not hard color shifts
- **Semantic restraint**: Warnings/errors use warmth, not aggression
- **Dual-mode harmony**: Light/dark modes use complementary hues (lime ↔ orange-tan)
- **Optical blending**: Borders and surfaces use `light-dark()` for context-aware rendering
- **Accessibility-first**: Contrast meets WCAG AA while preserving visual calm

### Syntax Highlighting (Markdown/Code Blocks)

- Strings: muted cyan/teal
- Keywords: desaturated pink/magenta
- Comments: inherit from `text-weak`
- Punctuation/operators: inherit from text hierarchy
- Diff additions: saturated green
- Diff deletions: warm orange/red

---

## CSS Variable Architecture

Export CSS custom properties organized by category:
- `--background-*` (base, weak, strong, stronger)
- `--surface-*` (base, inset, raised, float, brand, interactive, semantic)
- `--text-*` (base, weak, invert, interactive, on-color)
- `--border-*` (base, hover, active, selected, state-specific)
- `--icon-*` (base, hover, active, semantic)
- `--syntax-*` (language tokens)
- `--markdown-*` (rendering elements)

---

## Workflow Rules

1. **Small edits only in chat**: When implementing a feature or making changes, never write everything in a single code block. Split changes across separate files following industry-standard practices. Only use inline code blocks for trivial or negligible edits.

2. **Cross-platform compatibility**: All code must work on Windows, Linux, and macOS. Use `path` over string concatenation for file paths, avoid platform-specific shell commands, and handle OS differences (e.g., line endings, environment variables). The prompts I give may come from any platform — ensure the output works everywhere.

3. **Lint & typecheck**: Always run the lint and typecheck commands after making changes to verify correctness.

4. **No hardcoded values**: Never hardcode colors, spacing, fonts, file paths, or any configurable value. Use CSS custom properties for design tokens (`--background-*`, `--text-*`, `--border-*`, etc.), constants/enums for magic strings, and config files for paths and settings. Everything should be changeable from a single source of truth.

5. **Code style**: No comments in production code unless documenting an unavoidable complexity.

6. **Conventions**: Follow existing patterns in the codebase (naming, imports, component structure).

7. **No commit without ask**: Never commit changes unless explicitly requested by the user.

8. **No README/doc files**: Never create documentation files unless explicitly requested.
