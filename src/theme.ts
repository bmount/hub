// The theme: every color, font, size, radius, shadow and layout dimension, as CSS variables. A new look starts here
// (docs/ops/styling.md): components in src/styles.ts use only these names. Light by default, dark when the system asks.
export const THEME_CSS = `
:root{
--font:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
--space-1:4px;--space-2:8px;--space-3:12px;--space-4:16px;--space-6:24px;--space-8:32px;
--fs:14px;--fs-md:14px;--fs-sm:13px;--fs-xs:12px;--fs-h1:20px;--fs-chat:14px;--tap:28px;--row-h:28px;--separator:1px;
--r:4px;--r-sm:4px;--r-xs:2px;--shadow:0 8px 24px rgba(0,0,0,.12);
--rail-w:248px;--bar-h:42px;--status-h:24px;
--bg:#f2f4f7;--panel:#fff;--sunk:#eaeef2;--line:#d3dae2;--ink:#111a24;--muted:#46525f;--faint:#66727f;
--accent:#1b7a69;--accent-soft:#dff0ec;--focus:#1b7a69;
--state-open:var(--muted);--state-doing:var(--accent);--state-done:#1a7f37;--state-dropped:var(--faint);--state-blocked:#b42318;
--wish:#6d52de;--snag:#cc3d3d;--errand:#1b7a69;--quest:#a96f12;--call:#475569;--spark:#b4307a;
--add:#1a7f37;--add-bg:#e6f6ea;--del:#b42318;--del-bg:#fdecea;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{
--bg:#0e1217;--panel:#151a21;--sunk:#1a2028;--line:#2e3844;--ink:#eef2f6;--muted:#b4bfcb;--faint:#8f9cab;
--accent:#45c1aa;--accent-soft:#163430;--focus:#45c1aa;--shadow:0 8px 24px rgba(0,0,0,.5);
--state-done:#56d364;--state-blocked:#ff7b72;
--wish:#a593ff;--snag:#ff8578;--errand:#45c1aa;--quest:#e2b04f;--call:#a8b4c3;--spark:#f07ab8;
--add:#56d364;--add-bg:#12261a;--del:#ff7b72;--del-bg:#2d1517}}
@media (max-width:760px){:root{--tap:44px;--row-h:44px;--bar-h:56px}}
:root{--paper:var(--bg);--card:var(--panel);--soft:var(--sunk);--teal:var(--accent);--violet:var(--wish);--coral:var(--snag);--gold:var(--quest)}
`;
