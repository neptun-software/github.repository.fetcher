import { graphql } from "@octokit/graphql";
import type {
  SearchResultItemConnection,
  RateLimit,
  TreeEntry,
  Repository
} from "@octokit/graphql-schema";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const CHUNK_SIZE = 10; // Number of repositories per file
const DATA_DIR = "data";

if (!GITHUB_TOKEN) {
  throw new Error("Missing required environment variables (GITHUB_TOKEN).");
}

const graphqlWithAuth = graphql.defaults({
  headers: {
    authorization: `token ${GITHUB_TOKEN}`,
  },
});

type Repositories = Array<{
  nameWithOwner: Repository['nameWithOwner'];
  stars: Repository['stargazerCount'];
  defaultBranch: string;
  files: Files;
}>

type Files = Array<{
  name: TreeEntry['name'];
  type: TreeEntry['type'];
  size?: number;
  content?: string | null;
}>;

type ChunkMetadata = {
  timestamp: number;
  page: number;
  hasNextPage: boolean;
  endCursor: string | null;
  completionStatus: 'RATE_LIMITED' | 'COMPLETED' | 'ERROR' | 'IN_PROGRESS';
  error?: string;
};

async function getLatestChunk(): Promise<ChunkMetadata | null> {
  try {
    const metadataFile = Bun.file(join(DATA_DIR, 'metadata.json'));
    if (await metadataFile.exists()) {
      const metadata: ChunkMetadata = await metadataFile.json();
      return {
        timestamp: metadata.timestamp,
        page: metadata.page + 1,
        hasNextPage: metadata.hasNextPage,
        endCursor: metadata.endCursor,
        completionStatus: metadata.completionStatus || 'IN_PROGRESS'
      };
    }
  } catch (error) {
    console.warn('⚠️ Could not load metadata, starting fresh');
  }
  return null;
}

async function saveChunk(repositories: Repositories, metadata: ChunkMetadata) {
  await mkdir(DATA_DIR, { recursive: true });

  const filename = `repositories-${metadata.timestamp}-${metadata.page}.json`;
  const filePath = join(DATA_DIR, filename);

  const output = {
    metadata: {
      ...metadata,
      completionStatus: metadata.completionStatus || 'IN_PROGRESS'
    },
    repositories,
  };

  await Bun.write(filePath, JSON.stringify(output, null, 2));
  await Bun.write(join(DATA_DIR, 'metadata.json'), JSON.stringify(metadata, null, 2));

  console.log(`
📝 Chunk saved:
- Path: ${filePath}
- Page: ${metadata.page}
- Status: ${metadata.completionStatus}
- Repositories: ${repositories.length}
- Size: ${(Bun.file(filePath).size / 1024).toFixed(2)} KB`);
}

async function fetchTopRepositories() {
  let currentChunk: Repositories = [];
  let hasNextPage = true;
  let cursor: string | null = null;
  let page = 1;

  // Try to load existing metadata
  const lastChunk = await getLatestChunk();
  if (lastChunk) {
    // Only continue if the last chunk was rate limited or in progress
    if (lastChunk.completionStatus === 'RATE_LIMITED' || lastChunk.completionStatus === 'IN_PROGRESS') {
      hasNextPage = lastChunk.hasNextPage;
      cursor = lastChunk.endCursor;
      page = lastChunk.page;
      console.log('\n📂 Loaded existing metadata, continuing from:', {
        page,
        cursor,
        previousStatus: lastChunk.completionStatus
      });
    } else {
      console.log(`\n⚠️ Previous run was ${lastChunk.completionStatus}, starting fresh`);
    }
  }

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

        currentChunk.push({
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

        // Save chunk when it reaches CHUNK_SIZE
        if (currentChunk.length >= CHUNK_SIZE) {
          const metadata: ChunkMetadata = {
            timestamp: Date.now(),
            page,
            hasNextPage: search.pageInfo.hasNextPage,
            endCursor: search.pageInfo.endCursor ?? null,
            completionStatus: 'IN_PROGRESS'
          };

          await saveChunk(currentChunk, metadata);
          currentChunk = [];
          page++;
        }
      }

      // Update pagination variables
      hasNextPage = search.pageInfo.hasNextPage;
      cursor = search.pageInfo.endCursor ?? null;

      // Add delay to avoid rate limiting issues
      await new Promise(resolve => setTimeout(resolve, 50));

      console.log('\n=== Pagination Info ===');
      console.log(`Has next page: ${hasNextPage}`);
      console.log(`Next cursor: ${cursor}`);
      console.log('=====================\n');

      // Check if we're running low on rate limit
      if (rateLimit.remaining < rateLimit.cost) {
        console.log('⚠️ Rate limit nearly exhausted, stopping pagination');
        const metadata: ChunkMetadata = {
          timestamp: Date.now(),
          page,
          hasNextPage: true,
          endCursor: cursor,
          completionStatus: 'RATE_LIMITED'
        };
        if (currentChunk.length > 0) {
          await saveChunk(currentChunk, metadata);
        }
        console.log(`\n✅ Successfully saved progress before rate limit. Will resume from page ${page} next time.`);
        process.exit(0); // Exit successfully since this is an expected condition
      }
    }

    // Save any remaining repositories in the last chunk
    if (currentChunk.length > 0) {
      const metadata: ChunkMetadata = {
        timestamp: Date.now(),
        page,
        hasNextPage,
        endCursor: cursor,
        completionStatus: hasNextPage ? 'IN_PROGRESS' : 'COMPLETED'
      };
      await saveChunk(currentChunk, metadata);
    }

  } catch (error) {
    console.error('❌ Error fetching repositories:', error);
    // Save error state in metadata
    const metadata: ChunkMetadata = {
      timestamp: Date.now(),
      page,
      hasNextPage: true,
      endCursor: cursor,
      completionStatus: 'ERROR',
      error: error instanceof Error ? error.message : String(error)
    };
    if (currentChunk.length > 0) {
      await saveChunk(currentChunk, metadata);
    }
    throw error; // Re-throw to trigger the uncaught exception handler
  }
}

process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught Exception:', error);
});

fetchTopRepositories();
