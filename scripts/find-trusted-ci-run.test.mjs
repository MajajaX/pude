import assert from "node:assert/strict";
import test from "node:test";
import { isFullyValidated } from "./find-trusted-ci-run.mjs";

const fullSuite = [
  { name: "Detect changes", conclusion: "success" },
  { name: "Web and tooling (Node 22)", conclusion: "success" },
  { name: "Web and tooling (Node 24)", conclusion: "success" },
  { name: "Rust formatting", conclusion: "success" },
  { name: "Rust (ubuntu-latest)", conclusion: "success" },
  { name: "Rust (macos-latest)", conclusion: "success" },
  { name: "Rust (windows-latest)", conclusion: "success" },
  { name: "Security / npm advisories", conclusion: "success" },
  { name: "Workflow lint", conclusion: "skipped" },
  { name: "CI result", conclusion: "success" },
];

test("a run where every job passed is trusted, even without workflow lint", () => {
  assert.equal(isFullyValidated(fullSuite), true);
});

test("a run with a skipped test job was filtered by changed paths and is not trusted", () => {
  const filtered = fullSuite.map((job) => (job.name.startsWith("Rust (") ? { ...job, conclusion: "skipped" } : job));
  assert.equal(isFullyValidated(filtered), false);
});

test("a failed or cancelled job is not trusted", () => {
  for (const conclusion of ["failure", "cancelled"]) {
    const broken = fullSuite.map((job) => (job.name === "Rust formatting" ? { ...job, conclusion } : job));
    assert.equal(isFullyValidated(broken), false);
  }
});

test("a run missing a whole group of jobs is not trusted", () => {
  assert.equal(isFullyValidated(fullSuite.filter((job) => !job.name.startsWith("Security"))), false);
  assert.equal(isFullyValidated([]), false);
});
