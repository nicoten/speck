# Speck

A desktop reader for [OpenSpec](https://openspec.dev) projects. It groups a
project's documents by where they sit in the workflow and numbers them, so you
can read a project front to back instead of guessing which file comes next.

## How it decides the order

The order is not hardcoded. A project declares a workflow schema in
`openspec/config.yaml`, and that schema declares its artifacts and their
dependencies — for the stock `spec-driven` schema, `proposal → specs → design →
tasks`. Speck reads the order from there, so a project with a custom schema
is read in its own order.

Sections are fixed:

| Section | Contents |
| --- | --- |
| Project | `openspec/config.yaml` and any loose docs beside it |
| Active changes | each change, expanded in schema order |
| Current specs | the capability tree under `openspec/specs` |
| Archive | completed changes, most recently archived first |

Every document that exists gets a number in one project-wide reading sequence,
and the footer steps through it (`⌘[` / `⌘]`). An artifact the schema expects
but that has not been written yet stays visible as an open circle on the step
rail — in a spec-driven workflow that gap is information — but it takes no slot
in the sequence, so paging never lands on an empty document.

## Where the data comes from

The `openspec` CLI is the authority on ordering and change status, so Speck
prefers it: `openspec status --all --json`, `list --json`, and
`list --specs --json`, run with the working directory set to the project root.
Document bodies are read from the `.md` files directly, because
`openspec show --json` drops requirement names and all prose.

If the CLI is missing or answers with something unreadable, a built-in scanner
walks `openspec/` instead and the window says so rather than failing. A test
asserts both paths produce the same structure and ordering for the same
project, which is what keeps the fallback honest.

The CLI is looked up on `PATH`, then through a login shell, then in the usual
install locations — a macOS app launched from Finder does not inherit your
shell's `PATH`, so version-manager shims are invisible without that.

## Read-only

Speck never writes to a project. There is no filesystem write capability in
`tauri.conf.json`, shell execution is scoped to the `openspec` binary, and
document reads go through the app's own commands, which refuse any path outside
an open project.

Projects are watched while open, so a document rewritten by an agent or an
editor refreshes in place, keeping your scroll position.

## Installing

Download the `.dmg` from [the latest release](https://github.com/nicoten/speck/releases/latest)
and drag Speck to Applications. Builds are signed with a Developer ID and
notarised by Apple, so it opens with a double-click — no Gatekeeper detour.

Apple Silicon only for now; an Intel build would need a second release artifact.

Speck checks for a newer release on launch and offers it as a line in the top
bar; nothing is downloaded until you accept. Updates are verified against a
public key compiled into the app, so a release that is not signed with the
matching private key is refused.

## Running it

```sh
pnpm install
pnpm tauri dev      # development
pnpm tauri build    # bundle
pnpm test           # frontend tests
cd src-tauri && cargo test
```

## Releasing

Bump `version` in **both** `src-tauri/tauri.conf.json` and `package.json`, then:

```sh
./scripts/release.sh
gh release create v0.1.0 dist-release/* --title "Speck 0.1.0" --notes "..."
```

The script produces `dist-release/`:

| Artifact | Purpose |
| --- | --- |
| `Speck_<version>_arm64.dmg` | what people download |
| `Speck.app.tar.gz` | what the updater installs |
| `Speck.app.tar.gz.sig` | signature the app verifies |
| `latest.json` | the manifest the app polls |

All four must be attached to the release: the app reads the manifest from
`releases/latest/download/latest.json`, and the URL inside it points at that
version's tarball.

The version check compares the running app against the manifest, which is why
the two config files have to agree — the script refuses to build if they don't.

### Signing keys

`~/.speck/updater.key` and `~/.speck/updater.pass`, mode 600, outside this repo.

The script deliberately **clears any inherited `TAURI_SIGNING_*` variables** and
reads only those files. A key exported in a shell profile would otherwise sign
Speck with the wrong key, and the app would then reject its own updates with a
signature error that looks nothing like its cause.

**Losing the private key breaks updates for everyone already running Speck.**
Releases signed by a new key fail verification against the public key compiled
into installed copies, and every user has to reinstall by hand. Back it up.

## Design

Colour follows [openspec.dev](https://openspec.dev): warm paper, soft ink, and
the terracotta accent, which marks what you are reading now. Beyond that, the
only saturated colour in the interface encodes spec semantics — `ADDED`,
`MODIFIED`, `REMOVED`, `RENAMED`, and task progress — so a colour always means
something. Spectral sets the reading pane, Archivo the chrome, IBM Plex Mono
the code and small readouts. Fonts are bundled, so the app works offline.
