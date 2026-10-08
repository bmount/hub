# Design principles

## Don't make people click through (owner, 2026-10-08)

Pimwell should feel as direct as a good command line: say what you want, and it happens or is one press away.

- **Do it for them.** Wherever Pimwell can work something out (a name, a project, a filter, a destination), it
  does, instead of asking the person to navigate there.
- **Every page has an entry point.** "What do you want to do?" (spoken or typed) is first on the organization's
  home page, and the jump box offers "Do it" for any sentence.
- **Moving around happens at once.** An answer that is only a place is a redirect.
- **Changes are one card.** Anything that changes data comes back as one prefilled, editable form with one button.
  That button runs the ordinary verb, with every usual check.
- **Ask only when it matters.** A short follow-up question is for when the action itself is unclear. A missing
  detail is an empty field instead.
- **Build features as parameterized links and verbs,** so intent can be mapped to them. A new feature adds an entry
  to the catalog in `src/intent/catalog.ts`.

## Models see only what they need

- **The intent model** (`src/intent/model.ts`) sees the action catalog, its rules, and the person's own words in
  this exchange. It sees nothing else.
  - The module takes no request context and touches no database.
  - Names are matched afterwards, against what the person can see (`src/intent/resolve.ts`).
  - Its output is checked against the catalog, and anything else is discarded.
  - A test seeds distinctive names and checks that none reach the model.
- **Every model call** gets the least context that does the job, and treats the person's text as data, never as
  instructions.
