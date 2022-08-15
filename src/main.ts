import * as core from "@actions/core";
import * as github from "@actions/github";
import type { PullRequest } from "@octokit/webhooks-types";

interface ReviewerConfiguration {
  users: string[];
  requiredApproverCount: number;
}

interface Reviewers {
  /** a map of path prefix to review requirements */
  reviewers: { [key: string]: ReviewerConfiguration };
}

async function run(): Promise<void> {
  try {
    const authToken = core.getInput("github-token");
    const octokit = github.getOctokit(authToken);
    const context = github.context;

    if (github.context.eventName !== "pull_request") {
      core.setFailed(
        `Action invoked on an event != pull_request (${github.context.eventName}`
      );
      return;
    }

    const pr = github.context.payload as PullRequest;

    // load configuration, note that this call behaves differently with file sizes larger than 1MB
    const reviewersRequest = await octokit.rest.repos.getContent({
      ...context.repo,
      path: ".github/reviewers.json",
    });
    if (!("content" in reviewersRequest.data)) {
      core.setFailed("Unable to retrieve .github/reviewers.json");
      return;
    }
    const decodedContent = atob(
      reviewersRequest.data.content.replace(/\n/g, "")
    );
    const reviewersConfig = JSON.parse(decodedContent) as Reviewers;

    // note that this will truncate at >3000 files
    const allPrFiles = await octokit.rest.pulls.listFiles({
      ...context.repo,
      pull_number: pr.number,
    });

    const modifiedFilepaths = allPrFiles.data.map((file) => file.filename);

    // actual reviews
    const prReviews = await octokit.rest.pulls.listReviews({
      ...context.repo,
      pull_number: pr.number,
    });

    const approvals = prReviews.data
      .filter((review) => review.state === "APPROVED")
      .filter((review) => review.user !== null)
      .map((review) => review.user!.login); // eslint-disable-line @typescript-eslint/no-non-null-assertion

    let approved = true;
    for (const prefix in reviewersConfig.reviewers) {
      // find files that match the rule
      const affectedFiles = modifiedFilepaths.filter((file) =>
        file.startsWith(prefix)
      );

      if (affectedFiles.length > 0) {
        // evaluate rule
        const reviewRequirements = reviewersConfig.reviewers[prefix];
        const relevantApprovals = approvals.filter((user) =>
          reviewRequirements.users.find((u) => u === user)
        );
        const count = relevantApprovals.length;

        if (count < reviewRequirements.requiredApproverCount) {
          core.warning(
            "Modified Files:\n" +
              affectedFiles.map((f) => ` - ${f}\n`) +
              `Require ${reviewRequirements.requiredApproverCount} reviews from:\n` +
              reviewRequirements.users.map((u) => ` - ${u}\n`) +
              `But only found ${count} approvals: ` +
              `[${relevantApprovals.join(", ")}].`
          );
          approved = false;
        } else {
          core.info(`${prefix} review requirements met.`);
        }
      }
    }
    if (!approved) {
      core.setFailed("Missing required approvals.");
      return;
    }
    // pass
    core.info("All review requirements have been met");
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message);
  }
}

run();
