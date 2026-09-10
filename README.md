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
and drag Speck to Applications. The app is not notarised by Apple, so the first
launch needs right-click → Open rather than a double-click.

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

Releases are built on a maintainer's machine and signed with the updater key.

```sh
# The private key is not in this repo, and must not be.
export TAURI_SIGNING_PRIVATE_KEY_PATH=~/.speck/updater.key
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=

pnpm tauri build
```

That produces, under `src-tauri/target/release/bundle/`:

| Artifact | Purpose |
| --- | --- |
| `dmg/Speck_<version>_aarch64.dmg` | what people download |
| `macos/Speck.app.tar.gz` | what the updater installs |
| `macos/Speck.app.tar.gz.sig` | signature the app verifies |

A release then needs those two updater files plus a `latest.json` naming the
version, the signature, and the download URL — the app reads that manifest from
`releases/latest/download/latest.json`.

Bump `version` in `src-tauri/tauri.conf.json` and `package.json` together: the
updater compares the running app's version against the manifest, so a release
whose config was not bumped will not be offered.

**If the private key is lost, updates stop working for everyone already running
the app** — a new key means new releases fail verification against the old
public key, and each user has to reinstall by hand. It lives in `~/.speck/`.

## Design

Colour follows [openspec.dev](https://openspec.dev): warm paper, soft ink, and
the terracotta accent, which marks what you are reading now. Beyond that, the
only saturated colour in the interface encodes spec semantics — `ADDED`,
`MODIFIED`, `REMOVED`, `RENAMED`, and task progress — so a colour always means
something. Spectral sets the reading pane, Archivo the chrome, IBM Plex Mono
the code and small readouts. Fonts are bundled, so the app works offline.
