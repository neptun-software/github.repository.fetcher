# neptun.github.scraper

## Features

- Fetches repository metadata and file contents using GitHub's GraphQL API
- Chunks data into smaller files to manage memory usage
- Automated daily updates via GitHub Actions
- Data is versioned directly in the repository

## Setup

To install dependencies:

```bash
bun install
```

Create a `.env` file based on `.env.example` and add your GitHub token:

```env
GITHUB_TOKEN=your_github_token_here
```

## Running

To run manually:

```bash
bun run index.ts
```

The script will:

1. Create a `data` directory if it doesn't exist
2. Fetch repositories in chunks of 10
3. Save each chunk as `repositories-{timestamp}-{page}.json`
4. Keep track of progress in `data/metadata.json`

## GitHub Workflow

The repository includes a GitHub Actions workflow that:

- Runs daily at midnight UTC
- Fetches new repository data
- Commits and pushes changes directly to the repository
- Can be triggered manually via workflow_dispatch

## Data Structure

Each chunk file contains:

```json
{
  "metadata": {
    "timestamp": 1234567890,
    "page": 1,
    "hasNextPage": true,
    "endCursor": "cursor_string"
  },
  "repositories": [
    {
      "nameWithOwner": "owner/repo",
      "stars": 1000,
      "defaultBranch": "main",
      "files": [
        {
          "name": "filename",
          "type": "blob",
          "size": 1024,
          "content": "file contents (if < 1MB)" // else null
        }
      ]
    }
  ]
}
```

This project was created using `bun init` in bun v1.1.30. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.

## Limitations and Behavior

### GitHub API Limits

- The GitHub GraphQL API has a hard limit of 1000 items for search queries
- When this limit is reached, `hasNextPage` will be `false` and the `endCursor` will be at position 1000

### IP Allowlist Behavior

- Some repositories may have IP allowlist restrictions enabled
- These repositories are automatically skipped during fetching
- Skipped repositories still count towards the page number but not towards GitHub's 1000-item limit
- This can result in the page count being lower than the cursor position (e.g., page 982 with cursor at 1000)
