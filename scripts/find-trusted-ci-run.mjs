import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Workflow lint runs only for workflow changes, and the website deploy is opt-in.
const jobsThatMayBeSkipped = ["Workflow lint", "Deploy website"];
const jobsThatMustHaveRun = ["Web and tooling (", "Desktop end-to-end", "Rust formatting", "Rust (", "Security"];

/** A run is trusted only when the whole suite ran for its commit and every job succeeded. */
export function isFullyValidated(jobs) {
  if (jobs.length === 0) return false;
  const everyJobPassed = jobs.every(
    (job) => job.conclusion === "success" || (job.conclusion === "skipped" && jobsThatMayBeSkipped.includes(job.name)),
  );
  const everyRequiredJobPresent = jobsThatMustHaveRun.every((prefix) =>
    jobs.some((job) => job.name.startsWith(prefix)),
  );
  return everyJobPassed && everyRequiredJobPresent;
}

async function githubGet(path) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${path} answered ${response.status}`);
  return response.json();
}

async function findTrustedRun(repository, sha) {
  const { workflow_runs: runs } = await githubGet(
    `/repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&branch=main&status=success&per_page=10`,
  );
  for (const run of runs) {
    const { jobs } = await githubGet(`/repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
    if (isFullyValidated(jobs)) return run;
  }
  return undefined;
}

async function main() {
  const [sha] = process.argv.slice(2);
  const repository = process.env.GITHUB_REPOSITORY;
  if (!sha || !repository || !process.env.GH_TOKEN) {
    console.error("usage: GH_TOKEN=... GITHUB_REPOSITORY=owner/name find-trusted-ci-run.mjs <commit-sha>");
    process.exit(2);
  }

  let run;
  try {
    run = await findTrustedRun(repository, sha);
  } catch (error) {
    // A lookup failure only costs a full CI run; it must never let a release through unchecked.
    console.warn(`Could not look up an earlier CI run, so the full suite will run: ${error.message}`);
  }

  console.log(
    run
      ? `Reusing the complete CI run ${run.html_url} for ${sha}.`
      : `No complete CI run exists for ${sha}; the full suite will run.`,
  );
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `found=${run ? "true" : "false"}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
