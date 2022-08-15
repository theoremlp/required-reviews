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
const core = __importStar(require("@actions/core"));
const github = __importStar(require("@actions/github"));
async function run() {
    try {
        const authToken = core.getInput("github-token");
        const octokit = github.getOctokit(authToken);
        const context = github.context;
        if (github.context.eventName !== "pull_request") {
            core.setFailed(`Action invoked on an event != pull_request (${github.context.eventName}`);
            return;
        }
        const pr = github.context.payload;
        const reviewersRequest = await octokit.rest.repos.getContent({
            ...context.repo,
            path: ".github/reviewers.json",
        });
        if (!("content" in reviewersRequest.data)) {
            core.setFailed("Unable to retrieve .github/reviewers.json");
            return;
        }
        const reviewersConfig = JSON.parse(reviewersRequest.data.content);
        // note this will truncate at >3000 files
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
            .map((review) => review.user.login); // eslint-disable-line @typescript-eslint/no-non-null-assertion
        let approved = true;
        for (const prefix in reviewersConfig.reviewers) {
            // find files that match the rule
            const affectedFiles = modifiedFilepaths.filter((file) => file.startsWith(prefix));
            if (affectedFiles.length > 0) {
                // evaluate rule
                const conf = reviewersConfig.reviewers[prefix];
                const count = approvals.filter((user) => conf.users.find((u) => u === user)).length;
                if (count < conf.requiredApproverCount) {
                    core.warning("Files:\n" +
                        affectedFiles.map((f) => ` - ${f}\n`) +
                        `Require ${conf.requiredApproverCount} reviews from users:\n` +
                        conf.users.map((u) => `- ${u}\n` + `But only ${count} approvals were found.`));
                    approved = false;
                }
                else {
                    core.info(`${prefix} review requirements met`);
                }
            }
        }
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
