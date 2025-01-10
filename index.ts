import { graphql } from "@octokit/graphql";
import type {
  SearchResultItemConnection,
  RateLimit,
  Repository as GithubRepository,
  TreeEntry
} from "@octokit/graphql-schema";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!GITHUB_TOKEN) {
  throw new Error("Missing required environment variables (GITHUB_TOKEN).");
}

const graphqlWithAuth = graphql.defaults({
  headers: {
    authorization: `token ${GITHUB_TOKEN}`,
  },
});

type Files = Array<{
  name: TreeEntry['name'];
  type: TreeEntry['type'];
  size?: number;
  content?: string | null;
}>;

async function fetchTopRepositories() {
  let repositories: Array<{
    nameWithOwner: GithubRepository['nameWithOwner'];
    stars: GithubRepository['stargazerCount'];
    defaultBranch: string;
    files: Files;
  }> = [];
  let hasNextPage = true;
  let cursor: string | null = null;

  // Try to load existing data
  try {
    const file = Bun.file('repositories.json');
    if (await file.exists()) {
      const existingData = await file.json();
      repositories = existingData.repositories;
      hasNextPage = existingData.pagination.hasNextPage;
      cursor = existingData.pagination.endCursor;
      console.log('\n📂 Loaded existing data, continuing from cursor:', cursor);
    }
  } catch (error) {
    console.warn('⚠️ Could not load existing data, starting fresh');
  }

  const output = {
    repositories,
    pagination: {
      hasNextPage,
      endCursor: cursor
    }
  };

  try {
    while (hasNextPage) {
      const { search, rateLimit }: {
        search: SearchResultItemConnection;
        rateLimit: RateLimit;
      } = await graphqlWithAuth(`
        query getTopRepos($cursor: String) {
          search(
            query: "stars:>1000 sort:stars-desc"
            type: REPOSITORY
            first: 10
            after: $cursor
          ) {
            nodes {
              ... on Repository {
                nameWithOwner
                stargazerCount
                defaultBranchRef {
                  name
                  target {
                    ... on Commit {
                      tree {
                        entries {
                          name
                          type
                          object {
                            ... on Blob {
                              byteSize
                              text
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
          rateLimit {
            remaining
            limit
            cost
            resetAt
          }
        }
      `, {
        cursor: cursor
      });

      console.log('\n=== GitHub API Rate Limit ===');
      console.log(`Remaining: ${rateLimit.remaining}/${rateLimit.limit}`);
      console.log(`Cost of this query: ${rateLimit.cost}`);
      console.log(`Resets at: ${new Date(rateLimit.resetAt).toLocaleString()}`);
      console.log('===========================\n');

      // Process repositories
      if (!search.nodes) continue;

      for (const repo of search.nodes) {
        if (!repo || !('nameWithOwner' in repo)) continue;

        let repoData: Files = [];

        if (repo.defaultBranchRef?.target && 'tree' in repo.defaultBranchRef.target) {
          const tree = repo.defaultBranchRef.target.tree;
          if (tree?.entries) {
            repoData = tree.entries.map(entry => ({
              name: entry.name,
              type: entry.type,
              size: entry.object && 'byteSize' in entry.object ?
                Number((entry.object.byteSize / 1024).toFixed(2)) : undefined,
              content: entry.object && 'byteSize' in entry.object &&
                entry.object.byteSize < 1024 * 1024 &&
                'text' in entry.object &&
                entry.object.text ?
                entry.object.text : null
            }));
          }
        }

        repositories.push({
          nameWithOwner: repo.nameWithOwner,
          stars: repo.stargazerCount,
          defaultBranch: repo.defaultBranchRef?.name || 'unknown',
          files: repoData
        });

        // Keep existing console logging for visibility
        console.log(`\n📦 Repository: ${repo.nameWithOwner}`);
        console.log(`⭐ Stars: ${repo.stargazerCount.toLocaleString()}`);
        console.log(`🌿 Default branch: ${repo.defaultBranchRef?.name}`);

        if (!repo.defaultBranchRef?.target || !('tree' in repo.defaultBranchRef.target)) {
          console.log('❌ No files found in root');
          continue;
        }

        const tree = repo.defaultBranchRef.target.tree;
        if (!tree?.entries) {
          console.log('❌ No files found in root');
          continue;
        }

        console.log('\n📁 Files:');
        for (const entry of tree.entries) {
          const size = entry.object && 'byteSize' in entry.object
            ? `(${(entry.object.byteSize / 1024).toFixed(2)} KB)`
            : '';
          const icon = entry.type === 'tree' ? '📁' : '📄';
          console.log(`${icon} ${entry.name} ${size}`);
        }
        console.log('----------------------------');
      }

      // Update pagination variables and output
      output.pagination.hasNextPage = search.pageInfo.hasNextPage;
      output.pagination.endCursor = search.pageInfo.endCursor ?? null;
      hasNextPage = output.pagination.hasNextPage;
      cursor = output.pagination.endCursor;

      // After processing each batch, save to file
      try {
        const filePath = 'repositories.json';
        await Bun.write(filePath, JSON.stringify(output, null, 2));

        // Verify file was written
        const file = Bun.file(filePath);
        const exists = await file.exists();
        console.log(`
\n📝 File status:
- Path: ${filePath}
- Exists: ${exists}
- Size: ${exists ? (file.size / 1024).toFixed(2) : 0} KB`);
      } catch (writeError) {
        console.error('❌ Error writing file:', writeError);
      }

      // Add delay to avoid rate limiting issues
      await new Promise(resolve => setTimeout(resolve, 250));

      console.log('\n=== Pagination Info ===');
      console.log(`Has next page: ${hasNextPage}`);
      console.log(`Next cursor: ${cursor}`);
      console.log('=====================\n');

      // Check if we're running low on rate limit
      if (rateLimit.remaining < rateLimit.cost) {
        console.log('⚠️ Rate limit nearly exhausted, stopping pagination');
        break;
      }
    }

  } catch (error) {
    console.error('❌ Error fetching repositories:', error);
  }
}

process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught Exception:', error);
});

fetchTopRepositories();
