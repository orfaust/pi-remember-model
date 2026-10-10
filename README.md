# pi-remember-model

Pi extension that remembers the last selected model and thinking level for new sessions. The extension's behavior is unchanged from the original local version.

## Install locally

From this repository, run `pi install .` (user-level; do not pass `--local`). Pi loads the package directly from this checkout, so edits to `extensions/remember-model.ts` can be tested with `/reload` or a fresh Pi process. Use `pi list` to check the installed source. No copy into Pi's extensions directory is needed.

## Development

Edit `extensions/remember-model.ts` in this checkout. The `pi.extensions` manifest in `package.json` selects that file. Pi provides `@earendil-works/pi-coding-agent` at runtime; local packages are not modified by `pi install`.

The extension reads and writes `last-model.json` in Pi's user agent directory. That state file is **not** part of this repository. Keep credentials, personal settings, and session files outside the repository as well.
