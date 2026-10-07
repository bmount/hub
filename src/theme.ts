// The theme: every color, font, size, radius, shadow and layout dimension, as CSS variables. A new look starts here
// (docs/ops/styling.md): components in src/styles.ts use only these names. Light by default, dark when the system asks.
export const THEME_CSS = `
:root{
--font:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
--fs:14px;--fs-md:13px;--fs-sm:12.5px;--fs-xs:11.5px;--fs-h1:20px;
--r:6px;--r-sm:5px;--r-xs:3px;--shadow:0 8px 24px rgba(0,0,0,.12);
--rail-w:208px;--bar-h:42px;--status-h:24px;
--bg:#f2f4f7;--panel:#fff;--sunk:#eaeef2;--line:#d9dfe6;--ink:#17202b;--muted:#5d6a79;--faint:#8794a2;
--accent:#1b7a69;--accent-soft:#dff0ec;--focus:#1b7a69;
--wish:#6d52de;--snag:#cc3d3d;--errand:#1b7a69;--quest:#a96f12;--call:#475569;--spark:#b4307a}
@media (prefers-color-scheme:dark){:root{
--bg:#0e1217;--panel:#151a21;--sunk:#1a2028;--line:#28313c;--ink:#e3e8ee;--muted:#9ba7b4;--faint:#6d7987;
--accent:#45c1aa;--accent-soft:#163430;--focus:#45c1aa;--shadow:0 8px 24px rgba(0,0,0,.5);
--wish:#a593ff;--snag:#ff8578;--errand:#45c1aa;--quest:#e2b04f;--call:#a8b4c3;--spark:#f07ab8}}
:root{--paper:var(--bg);--card:var(--panel);--soft:var(--sunk);--teal:var(--accent);--violet:var(--wish);--coral:var(--snag);--gold:var(--quest)}
`;
