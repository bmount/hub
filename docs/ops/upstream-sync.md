# Manual upstream synchronization

With Node 22.18 or newer and Git installed, `npm run sync:upstream -- <upstream> <destination> <branch>` compares one existing imported branch. The upstream must be a public, credential-free `https://github.com/owner/repo.git` URL. The destination must be `https://organization.pimwell.com/repo.git`. Supply the mapping explicitly; the helper does not infer ownership from repository names.

The default is a dry run. Add `--apply` to fetch the upstream branch and push a fast-forward to Pimwell. It uses native Git and the destination's existing credential helper. Public upstream reads use isolated Git configuration and a temporary home directory, without credential helpers or `.netrc`. HTTP redirects and Git hooks are disabled. It requires the hosted branch to exist before pushing. It never writes to GitHub, forces updates, deletes refs or changes other branches or tags.

Diverged or rewound history is refused before pushing. Concurrent destination changes remain subject to Git's normal fast-forward checks. A push is reported successful only after the destination advertises the exact incoming commit. If a push is refused or its outcome cannot be verified, run a dry run to reconcile before applying again. Raw Git diagnostics are withheld because they can contain credentials or remote content.

This is a manual operator tool, not automatic synchronization. No schedule, upstream mapping store or private-upstream credential support is installed. The hub's five-minute Git event ingestion is separate: it reads Ardi's timeline but does not fetch GitHub changes.
