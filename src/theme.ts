// Shared design tokens. Components consume these in both root and organization views.
export const THEME_CSS = `
:root{
--font:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
--space-1:4px;--space-2:8px;--space-3:12px;--space-4:16px;--space-6:24px;--space-8:32px;
--fs:14px;--fs-md:14px;--fs-sm:13px;--fs-xs:12px;--fs-h1:20px;--fs-chat:14px;--tap:28px;--row-h:28px;--separator:1px;
--r:6px;--r-sm:4px;--r-xs:2px;--focus-width:2px;--focus-offset:2px;
--rail-w:248px;--bar-h:42px;--status-h:24px;
--bg:#cedde3;--rail:#d5e5e9;--panel:#ffffff;--group:#e1edf2;--raised:#ffffff;--secondary-gradient:linear-gradient(#ffffff,#e5edf1);--field:#eaf1f3;--hover:#dcebee;--selected:#cde9e3;
--sunk:var(--group);--line:#bdcdd2;--line-strong:#738d97;--highlight:#ffffff;
--ink:#152b34;--muted:#425c67;--faint:#49616d;
--accent:#096b59;--accent-soft:var(--selected);--focus:#1267b2;--blue:#185fa1;--indigo:#5142a1;
--primary-top:#117963;--primary-bottom:#075a4b;--primary-hover:#075647;--on-primary:#ffffff;
--primary-gradient:linear-gradient(var(--primary-top),var(--primary-bottom));--selected-gradient:linear-gradient(var(--group),var(--selected));
--elevation-1:0 2px 3px #152b3438;--elevation-2:0 3px 7px #152b3445;--bevel:inset 0 1px 0 #ffffffcc;--inset:inset 0 1px 3px #152b3426;--shadow:0 8px 24px #152b342e;
--attention:#91450c;--progress:var(--blue);--success:#176b38;--warning:#805600;--error:#b12b26;
--state-open:var(--muted);--state-doing:var(--progress);--state-done:var(--success);--state-dropped:var(--faint);--state-blocked:var(--error);
--wish:var(--indigo);--snag:var(--error);--errand:var(--accent);--quest:#805600;--call:#425c67;--spark:#9b2764;
--add:var(--success);--add-bg:#e0f1e5;--del:var(--error);--del-bg:#fbe6e3;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{
--bg:#0a131b;--rail:#19333f;--panel:#1b2d36;--group:#28434f;--raised:#2c4651;--secondary-gradient:linear-gradient(#365561,#243e49);--field:#12232c;--hover:#304c57;--selected:#244d47;
--line:#3d5964;--line-strong:#7c9ba6;--highlight:#43616d;
--ink:#edf5f7;--muted:#c0d2d9;--faint:#aac2cc;
--accent:#78dfbe;--focus:#8cc8ff;--blue:#91c9ff;--indigo:#bcb1ff;
--primary-top:#117963;--primary-bottom:#075a4b;--primary-hover:#075647;--on-primary:#ffffff;
--elevation-1:0 1px 2px #00000055;--elevation-2:0 2px 5px #00000066;--bevel:inset 0 1px 0 #ffffff26;--inset:inset 0 1px 3px #00000066;--shadow:0 8px 24px #00000080;
--attention:#ffbd86;--success:#88dfa0;--warning:#f1cf7b;--error:#ffb6ae;
--quest:#f1cf7b;--call:#c0d2d9;--spark:#f5a4cf;
--add-bg:#1b3d2c;--del-bg:#4a2d31}}
@media (max-width:760px){:root{--tap:44px;--row-h:44px;--bar-h:56px}}
:root{--paper:var(--bg);--card:var(--group);--soft:var(--sunk);--teal:var(--accent);--violet:var(--wish);--coral:var(--snag);--gold:var(--quest)}
`;
