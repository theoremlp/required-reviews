# Required Reviews Action

Requires reviews based on a configuration file held in the repository that maps file prefixes to authorized approvers and a required approver count.

## Configuration

This action reads `.github/reviewers.json` from the default branch. The file must be a JSON file that maps from file prefixes
to a list of users and a required review count. e.g.:

```json
{
    "teams": {
      "everyone": {
        "description": "a team that contains all users",
        "users": [
          "markelliot"
        ]
      }
    },
    "reviewers": {
        ".github/" {
            "description": "Require markelliot's approval on all changes to .github",
            "users": ["markelliot"],
            "requiredApproverCount": 1
        },
        "": {
            "description": "Require at least one approval on every file from the everyone team",
            "teams": ["everyone"],
            "requiredApproverCount": 1
        }
    },
    "overrides": [
      {
        "description": "Allow user 'bot' to make changes to yarn.lock",
        "onlyModifiedByUsers": ["bot"],
        "onlyModifiedFileRegExs": [
          "^yarn.lock$"
        ]
      }
    ]
}
```

## Configuring this action

To configure this action create a file in your `.github/workflows` directory:

```yaml
name: Required Reviews
on:
  pull_request: {}
  pull_request_review: {}
jobs:
  required-reviews:
    name: Required Reviews
    runs-on: ubuntu-latest
    steps:
      - name: required-reviewers
        uses: theoremlp/required-reviews@v2
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          # Optional: post a review on the PR instead of failing the task when requirements haven't been satisfied
          # post-review: true
```

Note that the post-review option will cause the task to succed, and should be used in concert with:

- requiring a review from the user that runs the action (controlled via the secret passed to the task)
- requiring the task runs to completion (so that reviews are required for each commit)
