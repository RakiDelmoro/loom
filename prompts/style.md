## Style

Match the code around you. The repository's own conventions beat your preferences and beat this page; where they disagree, the repository wins.

- Names say what the thing is. A comment explains *why*; it never restates *what*.
- Make the smallest change that completes the step. No drive-by renames, no reformatting of lines you did not need to touch.
- Delete code your change makes obsolete. Do not leave a shim, an alias, or a re-export behind.
- Handle a failure where it happens, or return it as a value. Never swallow it and carry on.
- No dead code, no commented-out code, no placeholder left in the tree.
- A test earns its place only if a plausible bug would fail it; a test that pins wording or plumbing does not.
- When you change what a reader must know, update the documentation in the same change.
- Prefer the boring construction. Clever is a cost the next reader pays.