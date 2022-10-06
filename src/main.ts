import * as core from "@actions/core";
import * as github from "@actions/github";
import { Context } from "@actions/github/lib/context";
import { GitHub } from "@actions/github/lib/utils";
import type {
  PullRequest,
  PullRequestReviewEvent,
} from "@octokit/webhooks-types";

type GitHubApi = InstanceType<typeof GitHub>;

interface TeamConfiguration {
  description?: string;
  users: string[];
}

interface ReviewerConfiguration {
  description?: string;
  teams?: string[];
  users?: string[];
  requiredApproverCount: number;
}

interface OverrideCriteria {
  description?: string;
  onlyModifiedByUsers?: string[];
  onlyModifiedFileRegExs?: string[];
}

interface Reviewers {
  /** a map of team name to team members */
  teams?: { [key: string]: TeamConfiguration };
  /** a map of path prefix to review requirements */
  reviewers: { [key: string]: ReviewerConfiguration };
  /** criteria that will overrule review requirements */
  overrides?: OverrideCriteria[];
}

async function loadConfig(octokit: GitHubApi, context: Context) {
  // load configuration, note that this call behaves differently than we expect with file sizes larger than 1MB
  const reviewersRequest = await octokit.rest.repos.getContent({
    ...context.repo,
    path: ".github/reviewers.json",
  });
  if (!("content" in reviewersRequest.data)) {
    return undefined;
  }
  const decodedContent = atob(reviewersRequest.data.content.replace(/\n/g, ""));
  return JSON.parse(decodedContent) as Reviewers;
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

function getPossibleApprovers(
  conf: ReviewerConfiguration,
  teams: { [key: string]: TeamConfiguration }
): Set<string> {
  const namedUsers = conf.users || [];
  const usersFromAllNamedTeams = (conf.teams || [])
    .map((team) => teams[team].users)
    .reduce((left, right) => [...left, ...right], []);
  return new Set([...namedUsers, ...usersFromAllNamedTeams]);
}

// note that this will truncate at >3000 files
async function getModifiedFilepaths(
  octokit: GitHubApi,
  context: Context,
  prNumber: number
) {
  const allPrFiles = await octokit.rest.pulls.listFiles({
    ...context.repo,
    pull_number: prNumber,
  });
  return allPrFiles.data.map((file) => file.filename);
}

async function getApprovals(
  octokit: GitHubApi,
  context: Context,
  prNumber: number
) {
  const prReviews = await octokit.rest.pulls.listReviews({
    ...context.repo,
    pull_number: prNumber,
  });

  const reviewStatus: { [key: string]: string } = {};
  // The reviews are in chronological order so we just need to use the latest state
  prReviews.data.forEach((review) => {
    // COMMENTED reviews do not affect the approval state
    if (review.user !== null && review.state != "COMMENTED") {
      reviewStatus[review.user.login] = review.state;
    }
  });

  const approvals = [];
  for (const login in reviewStatus) {
    if (reviewStatus[login] == "APPROVED") approvals.push(login);
  }

  return approvals;
}

async function getCommiters(
  octokit: GitHubApi,
  context: Context,
  prNumber: number
) {
  // capped at 250 commits
  const commits = await octokit.rest.pulls.listCommits({
    ...context.repo,
    pull_number: prNumber,
  });

  return commits.data.map((commit) => commit.committer?.login);
}

export function check(
  reviewersConfig: Reviewers,
  modifiedFilepaths: string[],
  approvals: string[],
  infoLog: (message: string) => void,
  warnLog: (message: string) => void
) {
  let approved = true;
  for (const prefix in reviewersConfig.reviewers) {
    // find files that match the rule
    const affectedFiles = modifiedFilepaths.filter((file) =>
      file.startsWith(prefix)
    );

    if (affectedFiles.length > 0) {
      // evaluate rule
      const reviewRequirements = reviewersConfig.reviewers[prefix];
      const possibleApprovers = getPossibleApprovers(
        reviewersConfig.reviewers[prefix],
        reviewersConfig.teams || {}
      );

      const relevantApprovals = approvals.filter((user) =>
        possibleApprovers.has(user)
      );
      const count = relevantApprovals.length;

      if (count < reviewRequirements.requiredApproverCount) {
        warnLog(
          "Modified Files:\n" +
            affectedFiles.map((f) => ` - ${f}\n`) +
            `Require ${reviewRequirements.requiredApproverCount} reviews from:\n` +
            "  users:" +
            (reviewRequirements.users
              ? "\n" + reviewRequirements.users.map((u) => ` - ${u}\n`)
              : " []\n") +
            "  teams:" +
            (reviewRequirements.teams
              ? "\n" + reviewRequirements.teams.map((t) => ` - ${t}\n`)
              : " []\n") +
            `But only found ${count} approvals: ` +
            `[${relevantApprovals.join(", ")}].`
        );
        approved = false;
      } else {
        infoLog(`${prefix} review requirements met.`);
      }
    }
  }
  return approved;
}

/** returns true if at least one OverrideCriteria is satisfied. */
export function checkOverride(
  overrides: OverrideCriteria[],
  modifiedFilePaths: string[],
  modifiedByUsers: (string | undefined)[]
) {
  return overrides.some((crit) => {
    let maybe = true;
    if (crit.onlyModifiedByUsers !== undefined) {
      const testSet = new Set(crit.onlyModifiedByUsers);
      maybe =
        maybe &&
        modifiedByUsers.every(
          (user) => user !== undefined && testSet.has(user)
        );
    }
    if (crit.onlyModifiedFileRegExs !== undefined) {
      maybe =
        maybe &&
        modifiedFilePaths.every((modifiedFile) =>
          crit.onlyModifiedFileRegExs?.some((pattern) =>
            new RegExp(pattern).test(modifiedFile)
          )
        );
    }
    return maybe;
  });
}

async function run(): Promise<void> {
  try {
    const authToken = core.getInput("github-token");
    const postReview = core.getInput("post-review") === "true";
    const octokit = github.getOctokit(authToken);
    const context = github.context;

    const prNumber = getPrNumber(context);
    if (prNumber === undefined) {
      core.setFailed(
        `Action invoked on unexpected event type '${github.context.eventName}'`
      );
      return;
    }

    const reviewersConfig = await loadConfig(octokit, context);
    if (!reviewersConfig) {
      core.setFailed("Unable to retrieve .github/reviewers.json");
      return;
    }

    const modifiedFilepaths = await getModifiedFilepaths(
      octokit,
      context,
      prNumber
    );
    const approvals = await getApprovals(octokit, context, prNumber);
    const committers = await getCommiters(octokit, context, prNumber);

    const approved = check(
      reviewersConfig,
      modifiedFilepaths,
      approvals,
      core.info,
      core.warning
    );
    if (!approved) {
      const override =
        reviewersConfig.overrides !== undefined &&
        checkOverride(reviewersConfig.overrides, modifiedFilepaths, committers);
      if (!override) {
        if (postReview) {
          await octokit.rest.pulls.createReview({
            ...context.repo,
            pull_number: prNumber,
            event: "REQUEST_CHANGES",
            body: "Missing required reviewers",
          });
        } else {
          core.setFailed("Missing required approvals.");
        }
        return;
      }
      // drop through
      core.info("Missing required approvals but allowing due to override.");
    }
    // pass
    if (postReview) {
      await octokit.rest.pulls.createReview({
        ...context.repo,
        pull_number: prNumber,
        event: "APPROVE",
        body: "All review requirements have been met",
      });
    }
    core.info("All review requirements have been met");
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    }
  }
}

run();
