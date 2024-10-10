# @pivanov/code-review

GitHub Action that leverages OpenAI to provide intelligent feedback and suggestions on
your pull requests.

## Setup

1. To use this GitHub Action, you need an OpenAI API key. If you don't have one, sign up for an API key
   at [OpenAI](https://beta.openai.com/signup).

2. Add the OpenAI API key as a GitHub Secret in your repository with the name `OPENAI_API_KEY`. You can find more
   information about GitHub Secrets [here](https://docs.github.com/en/actions/reference/encrypted-secrets).

3. Create a `.github/workflows/main.yml` file in your repository and add the following content:

```yaml
name: Code Review

on:
  pull_request:
    types:
      - opened
      - synchronize
permissions: write-all
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Repo
        uses: actions/checkout@v3

      - name: Code Review
        uses: pivanov/code-review@main
        with:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }} # The GITHUB_TOKEN is there by default so you just need to keep it like it is and not necessarily need to add it as secret as it will throw an error. [More Details](https://docs.github.com/en/actions/security-guides/automatic-token-authentication#about-the-github_token-secret)
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          OPENAI_API_MODEL: "gpt-4" # Optional: defaults to "gpt-4"
          exclude: "**/*.json, **/*.md" # Optional: exclude patterns separated by commas
          review_comment_prefix: "AI Review:" # Optional: prefix for review comments
          max_tokens: 16000 # Optional: maximum number of tokens for OpenAI API request
          max_files: 10 # Optional: maximum number of files to review
```

4. Customize the input parameters as needed:
   - `GITHUB_TOKEN`: The GitHub token is automatically provided by GitHub Actions. You don't need to set this manually.
   - `OPENAI_API_KEY`: Your OpenAI API key (required).
   - `OPENAI_API_MODEL`: The OpenAI model to use (optional, defaults to "gpt-4").
   - `exclude`: File patterns to exclude from review, separated by commas (optional).
   - `review_comment_prefix`: A prefix to add to all review comments (optional).
   - `max_tokens`: The maximum number of tokens to use in the OpenAI API request (optional, defaults to 16000).
   - `max_files`: The maximum number of files to review in a single pull request (optional, defaults to 10).

5. Commit the changes to your repository, and Code Reviewer will start working on your future pull requests.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for more information.
