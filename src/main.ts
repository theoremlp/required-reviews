import * as core from "@actions/core";
import * as github from "@actions/github";
import { Context } from "@actions/github/lib/context";
import type {
  PullRequest,
  PullRequestReviewEvent,
} from "@octokit/webhooks-types";

interface ReviewerConfiguration {
  users: string[];
  requiredApproverCount: number;
}

interface Reviewers {
  /** a map of path prefix to review requirements */
  reviewers: { [key: string]: ReviewerConfiguration };
}

function getPrNumber(context: Context): number | undefined {
  if (context.eventName === "pull_request") {
    return (github.context.payload as PullRequest).number;
  } else if (context.eventName === "pull_request_review") {
    return (github.context.payload as PullRequestReviewEvent).pull_request
      .number;
  }
  return undefined;
}

async function run(): Promise<void> {
  try {
    const authToken = core.getInput("github-token");
    const octokit = github.getOctokit(authToken);
    const context = github.context;

    const prNumber = getPrNumber(context);
    if (prNumber === undefined) {
      core.setFailed(
        `Action invoked on unexpected event type '${github.context.eventName}'`
      );
      return;
    }

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
      pull_number: prNumber,
    });

    const modifiedFilepaths = allPrFiles.data.map((file) => file.filename);

    // actual reviews
    const prReviews = await octokit.rest.pulls.listReviews({
      ...context.repo,
      pull_number: prNumber,
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
