import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UpdateSnapshotStore } from "../dist-electron/electron/update-snapshot-store.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-update-rollback-verify-"));
try {
  const userData = path.join(root, "user-data");
  const piHome = path.join(root, "pi-home");
  const snapshots = path.join(root, "snapshots");
  fs.mkdirSync(path.join(piHome, "sessions"), { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, "conversation-profiles.json"), JSON.stringify({ version: 1, profiles: [{ id: "fixture" }] }));
  fs.writeFileSync(path.join(piHome, "sessions", "fixture.jsonl"), "before-upgrade\n");
  const store = new UpdateSnapshotStore(snapshots, [
    { name: "user-data", path: userData },
    { name: "pi-home", path: piHome },
  ]);
  const snapshot = store.create("1.0.0");

  fs.writeFileSync(path.join(userData, "conversation-profiles.json"), JSON.stringify({ version: 2, profiles: [] }));
  fs.writeFileSync(path.join(piHome, "sessions", "fixture.jsonl"), "after-upgrade\n");
  const rollbackUserData = path.join(root, "rollback-user-data");
  const rollbackHome = path.join(root, "rollback-home");
  store.restoreTo(snapshot.id, { "user-data": rollbackUserData, "pi-home": rollbackHome });
  const profile = JSON.parse(fs.readFileSync(path.join(rollbackUserData, "conversation-profiles.json"), "utf8"));
  const session = fs.readFileSync(path.join(rollbackHome, "sessions", "fixture.jsonl"), "utf8");
  if (profile.version !== 1 || profile.profiles[0]?.id !== "fixture" || session !== "before-upgrade\n") {
    throw new Error("Rollback snapshot did not restore the pre-upgrade state exactly.");
  }
  console.log(`[update-rollback] verified upgrade mutation and integrity-checked rollback snapshot ${snapshot.id}`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
