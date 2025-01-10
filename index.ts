import { graphql } from "@octokit/graphql";
import type {
  SearchResultItemConnection,
  RateLimit
} from "@octokit/graphql-schema";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const PATH = process.env.GITHUB_PATH;

if (!GITHUB_TOKEN || !PATH) {
  throw new Error("Missing required environment variables");
}

const graphqlWithAuth = graphql.defaults({
  headers: {
    authorization: `token ${GITHUB_TOKEN}`,
  },
});

async function fetchTopRepositories() {
  let hasNextPage = true;
  let cursor: string | null = null;

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

      // Update pagination variables
      hasNextPage = search.pageInfo.hasNextPage;
      cursor = search.pageInfo.endCursor ?? null;

      // Add delay to avoid rate limiting issues
      await new Promise(resolve => setTimeout(resolve, 1000));

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

fetchTopRepositories();
