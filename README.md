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

## What Speck writes

Speck writes exactly one thing: **a task's checkbox**. Clicking a box in the
dashboard or in a `tasks.md` view flips one character on one line of that file.

Everything about that edit is deliberately narrow:

- Only a change's own `tasks.md`, under `openspec/changes/`. Specs, proposals
  and your project's code are refused by path, before anything is read.
- The task is addressed by its **text**, and by which occurrence where the same
  wording repeats — never by line number. An agent may have rewritten the file
  between it being read and the box being clicked, and a line number would then
  tick the wrong task with nothing to notice.
- If the task is no longer there, the write fails and says so. It never falls
  back to whatever now sits on that line.
- The rest of the file returns byte for byte: indentation, bullet style,
  spacing, line endings, and whether there was a trailing newline.
- The new content is written beside the file and renamed over it, so an
  interrupted write cannot leave a truncated task list.

Beyond that, Speck reads. Document reads go through the app's own commands,
which refuse any path outside an open project, and there is no filesystem write
capability in `tauri.conf.json` at all — the checkbox edit goes through that one
audited command.

**It can, however, start a Claude session that edits your repository.** That is
what `Apply` is for, and it is a deliberate change in what this app is. Nothing
starts without a confirmation that says so, and the authority the run gets is
chosen there rather than assumed.

Projects are watched while open, so a document rewritten by an agent or an
editor refreshes in place, keeping your scroll position.

## The project overview

Opening a project shows its overview, not a file: three counts — active
changes, open specs, archived — and then the project's own words about itself,
which is the `context` block from `openspec/config.yaml`. That prose exists to
brief an agent on the stack, conventions and domain, and it briefs a person
just as well.

The counts are a readout, not a control. Navigation belongs to the sidebar, and
a card that looks clickable but is not would be worse than a plain number.

`config.yaml` used to open by default, which was an accident of it being first
in the reading order rather than a decision — it is the least interesting file
in an OpenSpec project. It, and any other project-level document, is a row in
the sidebar's **Project** section.

The **Overview** row at the top of the sidebar comes back here.

## A change's dashboard

Clicking a change's **name** opens its dashboard; the **caret** to its left
shows or hides its documents. Two controls because they do two things — reading
about a change and navigating into its files are different intentions.

The dashboard is where the tasks live. The sidebar can say `5/14`; only this can
say *which nine* are still open, which is what you want before deciding whether
to apply it. It also shows each artifact's state, the files under it, and the
progress bar, and carries its own Apply button.

Tasks are read from `tasks.md` on the fly, so an agent ticking boxes updates the
dashboard as it works — and the boxes are clickable, so you can tick one off
yourself when you have verified it by hand.

## Pull requests, and the repository

OpenSpec records no pull request. There is no field for one, nothing in the CLI
knows about branches, and a change's `.openspec.yaml` holds workflow flags, not
links. So any link is **inference**, and Speck says so rather than presenting a
guess as a recorded fact.

Two strategies, in order:

1. **A branch named after the change.** One call, exact where that convention
   holds — but it is a convention, not a rule, and plenty of projects do not
   follow it.
2. **Pull requests containing commits that touched the change's own files**
   (`openspec/changes/<name>/`, and its dated path once archived). This works
   whatever a project calls its branches, which is why it exists.

The dashboard shows **all** of them, because a change is usually touched by more
than one: proposing it, applying it, archiving it. Picking one would mean
picking wrong — the most recent commit under an archived change is the *archive*
commit, so "the latest pull request" is the one that filed it away, not the one
that did the work.

When neither strategy finds anything, the row says what was looked for. When
`gh` is missing or not signed in, it says that instead of showing an empty
space. Lookups are cached for a minute.

The project's repository is read from `git remote get-url origin` and linked in
the top bar. Credentials in a remote are stripped, so a token never reaches the
screen. Links open only on that project's own forge host — the app will not open
an arbitrary URL handed to it.

## Running OpenSpec workflows

The whole OpenSpec circle starts from the app. `+` beside **Active changes**
proposes one; a change's dashboard carries **Apply**, **Verify** and
**Archive**. None of these is a plain CLI command — `openspec instructions
apply --json` produces a brief, and an agent carries it out.

So Speck hands off rather than driving. It writes a short script to the OS temp
directory and asks the system to open it, which starts a Claude session in your
terminal, in the project root. The work happens where you can watch it and
approve each step, and Speck's own guarantee is untouched. Progress comes back
on its own: the agent ticks boxes in `tasks.md`, the watcher notices, and
`Tasks 3/14` climbs in the sidebar while you read.

Emphasis follows the workflow rather than sitting still: Apply leads while
tasks remain, Verify leads once they are all ticked, and Archive stays quiet
because it rewrites your main specs and moves the change. Archive is also the
one that asks questions — how to merge the delta specs into the main specs —
which is another reason it belongs in a terminal.

Two things keep the handoff narrow:

- The webview asks for a **structured action** — apply, verify or archive a
  named change, or propose an idea — never a command line. It cannot ask Speck
  to run something else, and a change name is validated as a directory name
  rather than trusted.
- The prompt reaches the session **through a file** rather than interpolated
  into a command, so an idea containing `$(...)` or backticks arrives as text.

`propose` is planning-only by OpenSpec's own rules: it writes the proposal,
specs, design and tasks, then stops. `apply` is the one that implements code.

## Pull requests, and the repository

OpenSpec records no pull request. There is no field for one, nothing in the CLI
knows about branches, and a change's `.openspec.yaml` holds workflow flags, not
links. So any link is **inference**, and Speck says so rather than presenting a
guess as a recorded fact.

Two strategies, in order:

1. **A branch named after the change.** One call, exact where that convention
   holds — but it is a convention, not a rule, and plenty of projects do not
   follow it.
2. **Pull requests containing commits that touched the change's own files**
   (`openspec/changes/<name>/`, and its dated path once archived). This works
   whatever a project calls its branches, which is why it exists.

The dashboard shows **all** of them, because a change is usually touched by more
than one: proposing it, applying it, archiving it. Picking one would mean
picking wrong — the most recent commit under an archived change is the *archive*
commit, so "the latest pull request" is the one that filed it away, not the one
that did the work.

When neither strategy finds anything, the row says what was looked for. When
`gh` is missing or not signed in, it says that instead of showing an empty
space. Lookups are cached for a minute.

The project's repository is read from `git remote get-url origin` and linked in
the top bar. Credentials in a remote are stripped, so a token never reaches the
screen. Links open only on that project's own forge host — the app will not open
an arbitrary URL handed to it.

## Running OpenSpec workflows

The whole OpenSpec circle runs from the app. `+` beside **Active changes**
proposes one; a change's dashboard carries **Apply**, **Verify** and
**Archive**. None of these is a plain CLI command — `openspec instructions
apply --json` produces a brief, and an agent carries it out.

Emphasis follows the workflow rather than sitting still: Apply leads while
tasks remain, Verify leads once they are all ticked, and Archive stays quiet
because it rewrites your main specs and moves the change.

**Archive is better run in your terminal**, and the confirmation says so. The
workflow asks how to merge the change's delta specs into the main specs —
sync now, archive without syncing, or cancel — before doing anything. Run
in-app, headless, there is nobody to ask, so Claude decides that alone.

The session runs inside Speck and streams what it is doing into a panel above
the reading rail: the files it reads and edits, the commands it runs, what it
says, and how it ended. You can stop it at any point, which kills the process
mid-task — the panel says so rather than pretending the run completed.

Progress also arrives by itself, and that is the more reliable signal: the agent
ticks boxes in `tasks.md`, the watcher notices, and `Tasks 3/14` climbs in the
sidebar while you read.

### Permissions

An in-app session runs with permission prompts off. That is not a shortcut:
OpenSpec's workflows edit files *and* run commands — apply works through tasks
that build and test, verify runs checks, archive moves directories — and a
headless session has nobody to answer a prompt. Refusing commands does not make
a run safer, it makes it fail halfway and hand back a list of refusals.

So the choice is not which tools a session may use. It is **where it runs**: in
the app, where you watch a log and can stop it, or in your terminal, where each
step is approved before it happens. The confirmation says which you are getting.

### Running in a terminal instead

The same confirmation offers a terminal handoff: Speck writes a short script to
the OS temp directory and asks the system to open it, starting the session in
your own terminal at the project root. Approvals then happen in the Claude Code
UI, and Speck does not watch a session it does not run.

Two things keep either path narrow. The webview asks for a **structured
action** — apply a named change, or propose an idea — never a command line, and
a change name is validated as a directory name rather than trusted. For the
terminal path the prompt reaches the session **through a file** rather than
interpolated into a command, so an idea containing `$(...)` or backticks arrives
as text.

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

## The icon

`assets/icon.png` is the source: the artwork drawn on Apple's macOS icon grid,
an 824px squircle centred in 1024px, so the shipped icon needs no masking.
`src-tauri/icons/` is generated from it with `pnpm tauri icon assets/icon.png`,
and the mobile icon sets that command also writes are deleted: this is a desktop
app.

Whatever replaces it has to keep its marks separating at 32px — an earlier
version looked right at 512px and turned to mush in a Finder list.

## Design

Colour follows [openspec.dev](https://openspec.dev): warm paper, soft ink, and
the terracotta accent, which marks what you are reading now. Beyond that, the
only saturated colour in the interface encodes spec semantics — `ADDED`,
`MODIFIED`, `REMOVED`, `RENAMED`, and task progress — so a colour always means
something. Spectral sets the reading pane, Archivo the chrome, IBM Plex Mono
the code and small readouts. Fonts are bundled, so the app works offline.
