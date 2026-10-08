# Styling

Three files, one direction of dependency:

| File | Holds | Change it when |
| --- | --- | --- |
| `src/theme.ts` | Every color, font, size, radius, shadow and layout dimension, as CSS variables, light and dark | You want a new look. Most restyles end here. |
| `src/styles.ts` | Components (rail, panes, tables, chips, forms, cards), written only with the theme's variables | A component needs a different shape |
| `src/html.ts` | Markup of the frame (bar, rail, panes, status, tabs) and the class names pages use | The structure changes |

Both the stylesheet (theme plus components) and the workbench script are served from `src/assets.ts` as
`/assets/app.<hash>.css` and `/assets/wb.<hash>.js`. Each name carries a hash of the content, so browsers cache a file
for a year and any change gets a new name. No build step is involved.

## The variables

- **Type:** `--font`, and the sizes `--fs`, `--fs-md`, `--fs-sm`, `--fs-xs` and `--fs-h1`.
- **Readability (owner, 2026-10-08):** many readers are in their 50s and 60s, so type and contrast stay generous.
  - Phones (760px and narrower) redefine the sizes larger: 17px body, `--tap` 44px touch targets, `--bar-h` 56px.
    Components size buttons, inputs and rows from `--tap`, never from fixed numbers.
  - `--muted` and `--faint` keep at least 4.5:1 contrast on `--bg`.
  - `--fs-chat` sets the Assistant's reading size.
  - The bar and the tabs pad for the phone's safe areas (`env(safe-area-inset-*)`).
- **Shape:** `--r`, `--r-sm` and `--r-xs` (radii), and `--shadow`.
- **Layout:** `--rail-w`, `--bar-h` and `--status-h`.
- **Surfaces:** `--bg` (page), `--panel` (panes and cards), `--sunk` (rail, chips, table heads) and `--line`.
- **Text:** `--ink`, `--muted` and `--faint`.
- **Action:** `--accent` (links, selection edge, primary hover), `--accent-soft` (selected row) and `--focus`.
- **Work kinds:** `--wish`, `--snag`, `--errand`, `--quest`, `--call` and `--spark`.

Rules:
- **No raw values in components.** `src/styles.ts` holds no colors or fonts; add a variable instead.
- **Dark mode** is a second variable set in the same file, not separate component rules.
- **Phone and tablet** layouts are the two `@media` blocks at the end of `src/styles.ts` (at 1100 px and 760 px).
