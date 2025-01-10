import { graphql } from "@octokit/graphql";
import type { Repository } from "@octokit/graphql-schema";

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
  try {
    const { search, rateLimit } = await graphqlWithAuth<{
      search: { nodes: Repository[] },
      rateLimit: {
        remaining: number,
        limit: number,
        cost: number,
        resetAt: string
      }
    }>(`
      query getTopRepos {
        search(query: "stars:>50000 sort:stars-desc", type: REPOSITORY, first: 10) {
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
        }
        rateLimit {
          remaining
          limit
          cost
          resetAt
        }
      }
    `);

    console.log('\n=== GitHub API Rate Limit ===');
    console.log(`Remaining: ${rateLimit.remaining}/${rateLimit.limit}`);
    console.log(`Cost of this query: ${rateLimit.cost}`);
    console.log(`Resets at: ${new Date(rateLimit.resetAt).toLocaleString()}`);
    console.log('===========================\n');

    for (const repo of search.nodes) {
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
  } catch (error) {
    console.error('❌ Error fetching repositories:', error);
  }
}

fetchTopRepositories();
