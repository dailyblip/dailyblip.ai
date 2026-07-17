#!/usr/bin/env node
// pipeline/resolve-guides-conflict.mjs — invoked by every guide workflow's
// "Commit" step ONLY as a fallback, when the normal `git pull --rebase`
// hits a real conflict on data/guides.json. This does a JSON-aware merge
// instead of relying on git's line-based text merge, which doesn't
// understand that two commits touching DIFFERENT job records in the same
// array are logically independent, not actually conflicting with each
// other — that mismatch is exactly what caused real production failures,
// since data/guides.json can be written by THREE separate mechanisms
// (guide.yml, guide-publish.yml, guide-recheck.yml as git commits, AND
// admin.html directly via the GitHub Contents API, which Actions
// `concurrency` has no visibility into at all).
//
// Strategy: abandon git's own conflict resolution entirely. Take
// origin/main's latest version of the file as the base (since other jobs
// may have moved on without us), splice in ONLY the one job record this
// run was responsible for, and commit that as a clean new commit on top
// of origin/main rather than trying to rebase our old commit through
// their changes.
import { execSync } from "node:child_process";
import fs from "node:fs";

const jobId = process.argv[2];
const commitMessage = process.argv[3] || `guide ${jobId}: merged after concurrent write`;
if (!jobId) {
  console.error("usage: node resolve-guides-conflict.mjs <jobId> [commitMessage]");
  process.exit(1);
}

function sh(cmd) {
  return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] });
}

// Bail out of whatever rebase state the failed `git pull --rebase` left
// us in — we're not going to use git's own resolution at all below.
try { sh("git rebase --abort"); } catch { /* nothing to abort, fine */ }

sh("git fetch origin main");

const oursRaw = sh("git show HEAD:data/guides.json");
const theirsRaw = sh("git show origin/main:data/guides.json");
const ours = JSON.parse(oursRaw);
const theirs = JSON.parse(theirsRaw);

const ourJob = ours.find((g) => g.id === jobId);
if (!ourJob) {
  console.error(`resolve-guides-conflict: job ${jobId} not found in our own committed version — nothing to merge.`);
  process.exit(1);
}

// origin's array is the base (their other jobs may have changed without
// us knowing), with our own job's record spliced in — added if origin
// doesn't have it yet, replaced if it does.
const merged = theirs.filter((g) => g.id !== jobId);
merged.push(ourJob);

fs.writeFileSync("data/guides.json", JSON.stringify(merged, null, 2) + "\n");
sh("git add data/guides.json");

// Moves HEAD to origin/main WITHOUT touching the index or working tree —
// whatever's currently staged (our merged guides.json, plus any other
// files already committed earlier in this run, e.g. new images) stays
// staged, now diffed against origin/main's tree instead of our old
// commit's parent. Committing this produces a clean single commit on
// top of their latest state.
sh("git reset --soft origin/main");
sh(`git commit -m ${JSON.stringify(commitMessage)}`);

// One retry in case origin moved again in the brief window since our
// fetch above — a much smaller residual race than the one this script
// exists to fix, but cheap to guard against.
for (let attempt = 0; attempt < 2; attempt++) {
  try {
    sh("git push");
    console.log(`resolve-guides-conflict: merged and pushed job ${jobId} cleanly.`);
    process.exit(0);
  } catch (e) {
    if (attempt === 1) throw e;
    console.warn("resolve-guides-conflict: push raced again, retrying once more...");
    sh("git fetch origin main");
    sh("git reset --soft origin/main");
  }
}
