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

/** Extracts the last review from the provided {user, state} list and filter to only approving users. */
// visible for testing
export function getLastReviewApprovals(
  sparse: { user: string; state: string }[]
) {
  const lastReviewByUser = sparse.reduce((prev, curr) => {
    prev[curr.user] = curr.state;
    return prev;
  }, {} as { [key: string]: string });

  return Object.keys(lastReviewByUser).filter(
    (key) => lastReviewByUser[key] === "APPROVED"
  );
}

/** Gets current approvals. */
async function getApprovals(
  octokit: GitHubApi,
  context: Context,
  prNumber: number
) {
  // note this might eventually require some pagination
  const prReviews = await octokit.rest.pulls.listReviews({
    ...context.repo,
    pull_number: prNumber,
  });

  // map to a sparse representaiton to make testing the reduction logic a bit easier
  const sparse = prReviews.data.flatMap((review) =>
    review.user !== null ? { user: review.user.login, state: review.state } : []
  );

  return getLastReviewApprovals(sparse);
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

  return Array.from(
    new Set(commits.data.map((commit) => commit.author?.login)).values()
  );
}

/** Returns the last review by the authenticated user or undefined. */
async function getLastReview(
  octokit: GitHubApi,
  context: Context,
  prNumber: number
) {
  const currentUserLogin = await (
    await octokit.rest.users.getAuthenticated()
  ).data.login;
  const currentReviews = await octokit.rest.pulls.listReviews({
    ...context.repo,
    pull_number: prNumber,
  });
  const lastReview = currentReviews.data
    .filter((rev) => rev.user?.login === currentUserLogin)
    .slice(-1)
    .pop();
  return lastReview;
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
              ? "\n" + reviewRequirements.users.map((u) => `   - ${u}\n`)
              : " []\n") +
            "  teams:" +
            (reviewRequirements.teams
              ? "\n" + reviewRequirements.teams.map((t) => `   - ${t}\n`)
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
  modifiedByUsers: (string | undefined)[],
  infoLog: (message: string) => void,
  warnLog: (message: string) => void
) {
  return overrides.some((crit) => {
    if (
      crit.onlyModifiedByUsers === undefined &&
      crit.onlyModifiedFileRegExs === undefined
    ) {
      warnLog(
        `Ignoring override due to absent override criteria: ${crit.description}`
      );
      return false;
    }

    let wasOnlyModifiedByNamedUsers = true;
    let hasOnlyModifiedFileRegExs = true;
    if (crit.onlyModifiedByUsers !== undefined) {
      const testSet = new Set(crit.onlyModifiedByUsers);
      wasOnlyModifiedByNamedUsers = modifiedByUsers.every(
        (user) => user !== undefined && testSet.has(user)
      );
    }
    if (crit.onlyModifiedFileRegExs !== undefined) {
      hasOnlyModifiedFileRegExs = modifiedFilePaths.every((modifiedFile) =>
        crit.onlyModifiedFileRegExs?.some((pattern) =>
          new RegExp(pattern).test(modifiedFile)
        )
      );
    }
    infoLog(
      `Override: ${crit.description}:\n` +
        ` - only named users          : ${wasOnlyModifiedByNamedUsers} (${modifiedByUsers.join(
          ", "
        )})\n` +
        ` - only files matching regex : ${hasOnlyModifiedFileRegExs}`
    );
    return wasOnlyModifiedByNamedUsers && hasOnlyModifiedFileRegExs;
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
    const override =
      reviewersConfig.overrides !== undefined &&
      checkOverride(
        reviewersConfig.overrides,
        modifiedFilepaths,
        committers,
        core.info,
        core.warning
      );

    const allow = approved || override;
    if (postReview) {
      const lastReview = await getLastReview(octokit, context, prNumber);

      if (allow) {
        if (lastReview === undefined || lastReview.state !== "APPROVED") {
          await octokit.rest.pulls.createReview({
            ...context.repo,
            pull_number: prNumber,
            event: "APPROVE",
            body: "All review requirements have been met.",
          });
        }
      } else {
        if (
          lastReview === undefined ||
          lastReview.state !== "CHANGES_REQUESTED"
        ) {
          await octokit.rest.pulls.createReview({
            ...context.repo,
            pull_number: prNumber,
            event: "REQUEST_CHANGES",
            body: "Missing required reviewers.",
          });
        }
      }
    } else {
      if (approved) {
        core.info("All review requirements have been met");
      } else if (override) {
        core.info("Missing required approvals but allowing due to override.");
      } else {
        core.setFailed("Missing required approvals.");
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error);
    }
  }
}

run();
