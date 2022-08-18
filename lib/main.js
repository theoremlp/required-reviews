"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.check = void 0;
const core = __importStar(require("@actions/core"));
const github = __importStar(require("@actions/github"));
function getPrNumber(context) {
    if (context.eventName === "pull_request") {
        return github.context.payload.number;
    }
    else if (context.eventName === "pull_request_review") {
        return github.context.payload.pull_request
            .number;
    }
    return undefined;
}
function getPossibleApprovers(conf, teams) {
    const namedUsers = conf.users || [];
    const usersFromAllNamedTeams = (conf.teams || [])
        .map((team) => teams[team].users)
        .reduce((left, right) => [...left, ...right], []);
    return new Set([...namedUsers, ...usersFromAllNamedTeams]);
}
function check(reviewersConfig, modifiedFilepaths, approvals, infoLog, warnLog) {
    let approved = true;
    for (const prefix in reviewersConfig.reviewers) {
        // find files that match the rule
        const affectedFiles = modifiedFilepaths.filter((file) => file.startsWith(prefix));
        if (affectedFiles.length > 0) {
            // evaluate rule
            const reviewRequirements = reviewersConfig.reviewers[prefix];
            const possibleApprovers = getPossibleApprovers(reviewersConfig.reviewers[prefix], reviewersConfig.teams || {});
            const relevantApprovals = approvals.filter((user) => possibleApprovers.has(user));
            const count = relevantApprovals.length;
            if (count < reviewRequirements.requiredApproverCount) {
                warnLog("Modified Files:\n" +
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
                    `[${relevantApprovals.join(", ")}].`);
                approved = false;
            }
            else {
                infoLog(`${prefix} review requirements met.`);
            }
        }
    }
    return approved;
}
exports.check = check;
async function run() {
    try {
        const authToken = core.getInput("github-token");
        const octokit = github.getOctokit(authToken);
        const context = github.context;
        const prNumber = getPrNumber(context);
        if (prNumber === undefined) {
            core.setFailed(`Action invoked on unexpected event type '${github.context.eventName}'`);
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
        const decodedContent = atob(reviewersRequest.data.content.replace(/\n/g, ""));
        const reviewersConfig = JSON.parse(decodedContent);
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
            .map((review) => review.user.login); // eslint-disable-line @typescript-eslint/no-non-null-assertion
        const approved = check(reviewersConfig, modifiedFilepaths, approvals, core.info, core.warning);
        if (!approved) {
            core.setFailed("Missing required approvals.");
            return;
        }
        // pass
        core.info("All review requirements have been met");
    }
    catch (error) {
        if (error instanceof Error)
            core.setFailed(error.message);
    }
}
run();
