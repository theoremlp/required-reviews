# Required Reviews Action

Requires reviews based on a configuration file held in the repository that maps file prefixes to authorized approvers and a required approver count.

## Configuration

This action reads `.github/reviewers.json` from the default branch. The file must be a JSON file that maps from file prefixes
to a list of users and a required review count. e.g.:

```json
{
    "reviewers": {
        ".github/" {
            "users": ["markelliot"],
            "requiredApproverCount": 1
        }
    }
}
```

## Configuring this action

To configure this action create a file in your `.github/workflows` directory:

```yaml
name: Required Reviews
on:
  pull_request: {}
jobs:
  required-reviews:
    name: Required Reviews
    runs-on: ubuntu-latest
    steps:
      - name: required-reviewers
        uses: theoremlp/required-reviews@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
```
