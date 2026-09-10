// Checking for and installing app updates.
//
// The updater reads a manifest published with each GitHub release, verifies the
// bundle against the public key baked into tauri.conf.json, and only then
// applies it. A failed check is never fatal: the app is a reader and works fine
// on the version you already have.

import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "available"; version: string; notes: string | null }
  | { status: "downloading"; progress: number | null }
  | { status: "ready" }
  | { status: "failed"; message: string };

let pending: Update | null = null;

/** Look for a newer release. Returns the state to show, never throws. */
export async function checkForUpdate(): Promise<UpdateState> {
  try {
    const update = await check();
    if (!update) return { status: "idle" };
    pending = update;
    return {
      status: "available",
      version: update.version,
      notes: update.body ?? null,
    };
  } catch (e) {
    return { status: "failed", message: String(e) };
  }
}

/**
 * Download and install the update found by {@link checkForUpdate}, reporting
 * progress, then relaunch into the new version.
 */
export async function installUpdate(
  onState: (state: UpdateState) => void,
): Promise<void> {
  if (!pending) return;
  try {
    let total: number | null = null;
    let taken = 0;
    onState({ status: "downloading", progress: null });

    await pending.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          total = event.data.contentLength ?? null;
          break;
        case "Progress":
          taken += event.data.chunkLength;
          onState({
            status: "downloading",
            progress: total ? Math.round((taken / total) * 100) : null,
          });
          break;
        case "Finished":
          onState({ status: "ready" });
          break;
      }
    });

    await relaunch();
  } catch (e) {
    onState({ status: "failed", message: String(e) });
  }
}
