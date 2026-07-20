#!/usr/bin/env node
// pipeline/resolve-daily-conflict.js — fallback for daily.yml's Commit
// step when the normal `git pull --rebase` hits a real conflict.
//
// Unlike resolve-guides-conflict.js (which does a per-record JSON merge,
// since data/guides.json is an array of independent job records), the
// files daily.yml writes (docs/data/feed.json, archive pages, social
// posts) are each a COMPLETE regeneration from this run's fresh content
// scan — there's no sensible way to merge PARTS of two different runs'
// output together at a field level. So the strategy: take our own
// generated files as-is, but apply them ONTO the latest origin state
// rather than onto our own stale base — meaning anything origin has
// that we didn't touch this run is preserved correctly, and anything we
// DID touch uses our fresh version.
//
// IMPORTANT: this does NOT use `git reset --soft origin/main` alone to
// achieve that. Direct testing showed reset --soft doesn't pull ANY
// content from the new HEAD into the working tree — it only moves the
// branch pointer, leaving the working tree frozen at our own old base.
// That silently reverted a concurrent writer's change to a file we
// never touched ourselves back to our stale version of it, which is
// exactly backwards. So instead: explicitly capture which files our own
// commit changed, hard-reset to match latest origin exactly, then
// reapply only those specific files on top.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const commitMessage = process.argv[2] || "daily blip: resolved after concurrent write";

function sh(cmd) {
  return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] });
}

try { sh("git rebase --abort"); } catch { /* nothing to abort, fine */ }

// Exactly which files our own (failed-to-push) commit changed.
const changedFiles = sh("git diff --name-only HEAD~1 HEAD").trim().split("\n").filter(Boolean);
if (!changedFiles.length) {
  console.log("resolve-daily-conflict: no changed files found in our own commit, nothing to do.");
  process.exit(0);
}

// Snapshot our own version of exactly those files (and note which ones
// we actually deleted, vs modified/added) before the working tree gets
// reset out from under us.
const backups = new Map();
const deletedByUs = [];
for (const f of changedFiles) {
  if (fs.existsSync(f)) backups.set(f, fs.readFileSync(f));
  else deletedByUs.push(f);
}

function reapplyOurChanges() {
  for (const [f, content] of backups) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
  }
  for (const f of deletedByUs) {
    if (fs.existsSync(f)) fs.rmSync(f);
  }
  sh(`git add -A -- ${changedFiles.map((f) => JSON.stringify(f)).join(" ")}`);
}

sh("git fetch origin main");
// Working tree now EXACTLY matches latest origin, index included —
// unlike --soft, this actually pulls in whatever a concurrent writer
// changed for files we didn't touch ourselves.
sh("git reset --hard origin/main");
reapplyOurChanges();

let hasChanges = true;
try {
  sh("git diff --cached --quiet");
  hasChanges = false; // exit 0 = no staged differences
} catch {
  hasChanges = true; // exit 1 = there ARE staged differences
}

if (!hasChanges) {
  console.log("resolve-daily-conflict: nothing left to commit — our changes already match latest origin.");
  process.exit(0);
}

sh(`git commit -m ${JSON.stringify(commitMessage)}`);

for (let attempt = 0; attempt < 2; attempt++) {
  try {
    sh("git push");
    console.log("resolve-daily-conflict: pushed cleanly after resolving conflict.");
    process.exit(0);
  } catch (e) {
    if (attempt === 1) throw e;
    console.warn("resolve-daily-conflict: push raced again, retrying once more...");
    sh("git fetch origin main");
    sh("git reset --hard origin/main");
    reapplyOurChanges();
    sh(`git commit -m ${JSON.stringify(commitMessage)}`);
  }
}
