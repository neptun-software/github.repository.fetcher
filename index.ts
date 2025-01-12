import { graphql } from "@octokit/graphql";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type {
  SearchResultItemConnection,
  RateLimit,
  TreeEntry,
  Repository
} from "@octokit/graphql-schema";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// Using more than one risks data loss, because fileContents are not fetched, if the root is too large, and there is not way, to check this in the query (you can only check total like so size:<10240).
const CHUNK_SIZE = 1; // Number of repositories per file.

// Path constants
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, "data");
const LOG_FILE = join(DATA_DIR, "error.log");
const GLOBAL_METADATA_FILE = join(DATA_DIR, "global-metadata.json");
const METADATA_FILE = join(DATA_DIR, "metadata.json");

if (!GITHUB_TOKEN) {
  throw new Error("Missing required environment variables (GITHUB_TOKEN).");
}

const graphqlWithAuth = graphql.defaults({
  headers: {
    authorization: `token ${GITHUB_TOKEN}`,
    'user-agent': 'neptun-repository-fetcher/1.0',
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

type StarRange = {
  min: number;
  max: number;
  label: string;
};

type Language = {
  name: string;
  repositoryCount: number;
};

const STAR_RANGES: StarRange[] = [
  { min: 1000, max: 5000, label: '1000-5000' },
  { min: 5001, max: 10000, label: '5001-10000' },
  { min: 10001, max: 25000, label: '10001-25000' },
  { min: 25001, max: 50000, label: '25001-50000' },
  { min: 50001, max: 100000, label: '50001-100000' },
  { min: 100001, max: 1000000, label: '100001-plus' },
];

type GlobalMetadata = {
  timestamp: number;
  currentLanguage: string | null;
  currentStarRange: string | null;
  completedSegments: Array<{
    language: string;
    starRange: string;
    completionStatus: ChunkMetadata['completionStatus'];
  }>;
};

async function loadGlobalMetadata(): Promise<GlobalMetadata> {
  try {
    const file = Bun.file(GLOBAL_METADATA_FILE);
    if (await file.exists()) {
      return await file.json();
    }
  } catch (error) {
    // If file doesn't exist or is invalid JSON, return default metadata
  }
  return {
    timestamp: Date.now(),
    currentLanguage: null,
    currentStarRange: null,
    completedSegments: []
  };
}

async function saveGlobalMetadata(metadata: GlobalMetadata) {
  try {
    await Bun.write(GLOBAL_METADATA_FILE, JSON.stringify(metadata, null, 2), { createPath: true });
  } catch (error) {
    await logError('Failed to save global metadata, but continuing:', error);
  }
}

async function logError(message: string, error?: any) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n${error ? `Error: ${JSON.stringify(error, null, 2)}\n` : ''}\n`;

  const file = Bun.file(LOG_FILE);
  const existingContent = await file.exists() ? await file.text() : '';
  await Bun.write(LOG_FILE, existingContent + logMessage, { createPath: true });

  console.error(message);
  if (error) console.error(error);
}

async function getLatestChunk(): Promise<ChunkMetadata | null> {
  try {
    const metadataFile = Bun.file(METADATA_FILE);
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

async function saveChunk(repositories: Repositories, metadata: ChunkMetadata, dir: string = DATA_DIR) {
  const filename = `repositories-${metadata.timestamp}-${metadata.page}.json`;
  const fullPath = join(dir, filename);

  try {
    await Bun.write(fullPath, JSON.stringify({ metadata, repositories }, null, 2), { createPath: true });
    console.log(`✅ Saved ${repositories.length} repositories to ${filename}`);
  } catch (error) {
    console.error('Error details:', error);
    await logError(`Failed to save chunk to ${fullPath}, but continuing:`, error);
  }
}

async function fetchRepositoryData(nameWithOwner: string, withBlobContents: boolean = true) {
  const [owner, name] = nameWithOwner.split('/');
  try {
    const { repository }: { repository: Repository } = await graphqlWithAuth(`
      query getRepoFiles($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) {
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
                        ${withBlobContents ? 'text' : ''}
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `, {
      owner,
      name
    });

    return repository;
  } catch (error) {
    await logError(`Error processing ${nameWithOwner}:`, error);

    return {
      defaultBranchRef: {
        name: 'unknown',
        target: {
          tree: {
            entries: []
          }
        }
      }
    };
  }
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
      // Reset pagination when starting fresh
      cursor = null;
      page = 1;
      hasNextPage = true;
    }
  }

  try {
    while (hasNextPage) {
      let search: SearchResultItemConnection;
      let rateLimit: RateLimit;

      try {
        const result: { search: SearchResultItemConnection; rateLimit: RateLimit } = await graphqlWithAuth(`
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
          cursor
        });
        search = result.search;
        rateLimit = result.rateLimit;
      } catch (error: any) {
        // Move to next page
        cursor = error.response?.data?.search?.pageInfo?.endCursor ?? cursor;
        continue;
      }

      // Update pagination variables before processing repositories
      // This ensures we don't lose our place if processing fails
      hasNextPage = search.pageInfo.hasNextPage;
      cursor = search.pageInfo.endCursor ?? null;

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
        let fetchedRepo;

        try {
          // First try with blob contents
          fetchedRepo = await fetchRepositoryData(repo.nameWithOwner, true);
          if (fetchedRepo.defaultBranchRef?.name === 'unknown') {
            console.log(`⚠️ Limited access to ${repo.nameWithOwner} due to IP restrictions - skipping`);
            continue;
          } else {
            console.log(`✅ Successfully fetched ${repo.nameWithOwner} with blob contents`);
          }
        } catch (error) {
          await logError(`Failed to fetch ${repo.nameWithOwner} with blob contents, retrying without...`, error);
          try {
            // Retry without blob contents
            fetchedRepo = await fetchRepositoryData(repo.nameWithOwner, false);
            console.log(`✅ Successfully fetched ${repo.nameWithOwner} without blob contents`);
          } catch (retryError) {
            await logError(`Failed to fetch ${repo.nameWithOwner} even without blob contents:`, retryError);
            continue;
          }
        }

        if (fetchedRepo.defaultBranchRef?.target && 'tree' in fetchedRepo.defaultBranchRef.target) {
          const tree = fetchedRepo.defaultBranchRef.target.tree;
          if (tree?.entries) {
            repoData = tree.entries.map(entry => ({
              name: entry.name,
              type: entry.type,
              size: entry.object && 'byteSize' in entry.object ? entry.object.byteSize / 1024 : undefined,
              content: entry.object && 'text' in entry.object ? entry.object.text : null
            }));
          }
        }

        currentChunk.push({
          nameWithOwner: repo.nameWithOwner,
          stars: repo.stargazerCount,
          defaultBranch: fetchedRepo.defaultBranchRef?.name || 'unknown',
          files: repoData
        });

        // Keep existing console logging for visibility
        console.log(`\n📦 Repository: ${repo.nameWithOwner}`);
        console.log(`⭐ Stars: ${repo.stargazerCount.toLocaleString()}`);
        console.log(`🌿 Default branch: ${fetchedRepo.defaultBranchRef?.name}`);

        if (!fetchedRepo.defaultBranchRef?.target || !('tree' in fetchedRepo.defaultBranchRef.target)) {
          console.log('❌ No files found in root');
          continue;
        }

        const tree = fetchedRepo.defaultBranchRef.target.tree;
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
            hasNextPage,
            endCursor: cursor,
            completionStatus: 'IN_PROGRESS'
          };

          await saveChunk(currentChunk, metadata);
          currentChunk = [];
          page++;
        }
      }

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
    await logError(`Error fetching repositories:`, error);
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
    // Error has been logged and metadata saved, continue processing
  }
}

async function fetchLanguagesWithPopularRepos(): Promise<Language[]> {
  try {
    const result: {
      search: {
        repositories: Array<{
          primaryLanguage?: {
            name: string;
          } | null;
        } | null>;
      };
    } = await graphqlWithAuth(`
      query getLanguages {
        search(
          query: "stars:>1000 sort:stars-desc"
          type: REPOSITORY
          first: 100
        ) {
          repositories: nodes {
            ... on Repository {
              primaryLanguage {
                name
              }
            }
          }
        }
      }
    `);

    const languages = new Map<string, number>();

    for (const repo of result.search.repositories) {
      if (repo?.primaryLanguage?.name) {
        const count = languages.get(repo.primaryLanguage.name) || 0;
        languages.set(repo.primaryLanguage.name, count + 1);
      }
    }

    // Return all languages without filtering, just sort by count
    return Array.from(languages.entries())
      .map(([name, count]) => ({ name, repositoryCount: count }))
      .sort((a, b) => b.repositoryCount - a.repositoryCount)
      .filter(lang => lang.name !== null);
  } catch (error) {
    await logError('Failed to fetch languages, returning empty list:', error);
    return [];
  }
}

async function fetchRepositoriesForLanguageAndStars(
  language: string,
  starRange: StarRange,
  cursor: string | null = null
): Promise<{ search: SearchResultItemConnection; rateLimit: RateLimit }> {
  try {
    // Wrap language in quotes if it contains spaces
    const languageQuery = language.includes(' ') ? `"${language}"` : language;

    return await graphqlWithAuth(`
      query getReposByLanguageAndStars($cursor: String) {
        search(
          query: "language:${languageQuery} stars:${starRange.min}..${starRange.max} sort:stars-desc"
          type: REPOSITORY
          first: 10
          after: $cursor
        ) {
          nodes {
            ... on Repository {
              nameWithOwner
              stargazerCount
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
      cursor
    });
  } catch (error) {
    await logError(`Failed to fetch repositories for ${language} with stars ${starRange.label}:`, error);
    return {
      search: {
        nodes: [],
        pageInfo: {
          hasNextPage: false,
          hasPreviousPage: false,
          startCursor: null,
          endCursor: null
        },
        codeCount: 0,
        discussionCount: 0,
        issueCount: 0,
        repositoryCount: 0,
        userCount: 0,
        wikiCount: 0
      },
      rateLimit: {
        remaining: 0,
        limit: 0,
        cost: 0,
        resetAt: new Date().toISOString(),
        nodeCount: 0,
        used: 0
      }
    };
  }
}

async function processLanguageAndStarRange(language: string, starRange: StarRange) {
  // Check if this segment is already completed in global metadata
  let globalMetadata = await loadGlobalMetadata();
  const isCompleted = globalMetadata.completedSegments.some(
    seg => seg.language === language &&
      seg.starRange === starRange.label &&
      seg.completionStatus === 'COMPLETED'
  );

  if (isCompleted) {
    console.log(`⏩ Skipping completed segment ${language}/${starRange.label}`);
    return;
  }

  const outputDir = join(DATA_DIR, language, starRange.label);
  const metadataPath = join(outputDir, "metadata.json");

  let currentChunk: Repositories = [];
  let hasNextPage = true;
  let cursor: string | null = null;
  let page = 1;

  // Try to load existing metadata for this language/range
  let metadata: ChunkMetadata | null = null;
  try {
    const file = Bun.file(metadataPath);
    if (await file.exists()) {
      try {
        metadata = await file.json() as ChunkMetadata;
        if (metadata.completionStatus === 'RATE_LIMITED' || metadata.completionStatus === 'IN_PROGRESS') {
          hasNextPage = metadata.hasNextPage;
          cursor = metadata.endCursor;
          page = metadata.page + 1;
          console.log(`\n📂 Loaded existing metadata for ${language}/${starRange.label}, continuing from:`, {
            page,
            cursor,
            previousStatus: metadata.completionStatus
          });
        }
      } catch (parseError) {
        await logError(`Invalid metadata file for ${language}/${starRange.label}, starting fresh:`, parseError);
      }
    } else {
      console.log(`\n📂 Starting fresh for ${language}/${starRange.label}`);
    }
  } catch (error) {
    // No existing metadata or invalid file - start fresh
    console.log(`\n📂 Starting fresh for ${language}/${starRange.label}`);
  }

  try {
    while (hasNextPage) {
      const { search, rateLimit } = await fetchRepositoriesForLanguageAndStars(language, starRange, cursor);

      hasNextPage = search.pageInfo.hasNextPage;
      cursor = search.pageInfo.endCursor ?? null;

      console.log(`\n=== GitHub API Rate Limit (${language}/${starRange.label}) ===`);
      console.log(`Remaining: ${rateLimit.remaining}/${rateLimit.limit}`);
      console.log(`Cost of this query: ${rateLimit.cost}`);
      console.log(`Resets at: ${new Date(rateLimit.resetAt).toLocaleString()}`);
      console.log('===========================\n');

      if (!search.nodes) continue;

      for (const repo of search.nodes) {
        if (!repo || !('nameWithOwner' in repo)) continue;

        try {
          const fetchedRepo = await fetchRepositoryData(repo.nameWithOwner, true);
          if (fetchedRepo.defaultBranchRef?.name === 'unknown') {
            console.log(`⚠️ Limited access to ${repo.nameWithOwner} due to IP restrictions - skipping`);
            continue;
          }

          const entries = fetchedRepo.defaultBranchRef?.target &&
            'tree' in fetchedRepo.defaultBranchRef.target ?
            fetchedRepo.defaultBranchRef.target.tree?.entries : undefined;
          if (!entries) continue;

          currentChunk.push({
            nameWithOwner: repo.nameWithOwner,
            stars: repo.stargazerCount,
            defaultBranch: fetchedRepo.defaultBranchRef?.name || 'main',
            files: entries.map((entry: TreeEntry) => {
              const obj = entry.object;
              return {
                name: entry.name,
                type: entry.type,
                size: obj && 'byteSize' in obj ? obj.byteSize / 1024 : undefined,
                content: obj && 'text' in obj ? obj.text : null
              };
            })
          });

          if (currentChunk.length >= CHUNK_SIZE) {
            const metadata: ChunkMetadata = {
              timestamp: Date.now(),
              page,
              hasNextPage,
              endCursor: cursor,
              completionStatus: 'IN_PROGRESS'
            };
            await saveChunk(currentChunk, metadata, outputDir);
            // Save segment metadata after each chunk
            await Bun.write(metadataPath, JSON.stringify(metadata, null, 2));
            currentChunk = [];
            page++;
          }
        } catch (error) {
          await logError(`Failed to process ${repo.nameWithOwner}:`, error);
          continue;
        }
      }

      if (rateLimit.remaining < rateLimit.cost) {
        console.log(`⚠️ Rate limit nearly exhausted for ${language}/${starRange.label}, stopping pagination`);
        const metadata: ChunkMetadata = {
          timestamp: Date.now(),
          page,
          hasNextPage: true,
          endCursor: cursor,
          completionStatus: 'RATE_LIMITED'
        };
        if (currentChunk.length > 0) {
          await saveChunk(currentChunk, metadata, outputDir);
        }
        // Save overall metadata
        await Bun.write(metadataPath, JSON.stringify(metadata, null, 2));
        return;
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
      await saveChunk(currentChunk, metadata, outputDir);
      await Bun.write(metadataPath, JSON.stringify(metadata, null, 2));
    }

  } catch (error) {
    await logError(`Error processing ${language}/${starRange.label}:`, error);
    const metadata: ChunkMetadata = {
      timestamp: Date.now(),
      page,
      hasNextPage: true,
      endCursor: cursor,
      completionStatus: 'ERROR',
      error: error instanceof Error ? error.message : String(error)
    };
    if (currentChunk.length > 0) {
      await saveChunk(currentChunk, metadata, outputDir);
    }
    await Bun.write(metadataPath, JSON.stringify(metadata, null, 2));
    await logError('Failed to save metadata, but continuing:', error);
  }
}

async function main() {
  try {
    console.log('🔍 Fetching languages with popular repositories...');
    const languages = await fetchLanguagesWithPopularRepos();
    console.log(`Found ${languages.length} languages with popular repositories`);

    let globalMetadata = await loadGlobalMetadata();
    // Validate global metadata structure
    if (!globalMetadata || typeof globalMetadata !== 'object') {
      await logError('Invalid global metadata, starting fresh', globalMetadata);
      globalMetadata = {
        timestamp: Date.now(),
        currentLanguage: null,
        currentStarRange: null,
        completedSegments: []
      };
    }

    // Ensure completedSegments is an array
    if (!Array.isArray(globalMetadata.completedSegments)) {
      await logError('Invalid completedSegments in metadata, resetting', globalMetadata.completedSegments);
      globalMetadata.completedSegments = [];
    }

    let startFromLanguage = globalMetadata.currentLanguage;
    let startFromRange = globalMetadata.currentStarRange;
    let shouldSkip = startFromLanguage !== null;

    for (const language of languages) {
      // Skip until we reach the language we were processing
      if (shouldSkip && language.name !== startFromLanguage) {
        continue;
      }
      shouldSkip = false;

      console.log(`\n📚 Processing ${language.name} (${language.repositoryCount} repositories)`);

      for (const starRange of STAR_RANGES) {
        // Skip until we reach the range we were processing
        if (startFromLanguage === language.name && startFromRange && starRange.label !== startFromRange) {
          continue;
        }
        startFromRange = null;

        // Update current position
        globalMetadata.currentLanguage = language.name;
        globalMetadata.currentStarRange = starRange.label;
        await saveGlobalMetadata(globalMetadata);

        await processLanguageAndStarRange(language.name, starRange);

        // Mark segment as completed
        globalMetadata.completedSegments.push({
          language: language.name,
          starRange: starRange.label,
          completionStatus: 'COMPLETED'
        });
        await saveGlobalMetadata(globalMetadata);
      }

      // Clear current language when done with all its ranges
      globalMetadata.currentLanguage = null;
      globalMetadata.currentStarRange = null;
      await saveGlobalMetadata(globalMetadata);
    }

    console.log('\n✅ Completed processing all languages and star ranges');
  } catch (error) {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  }
}

main();

process.on('uncaughtException', async (error) => {
  await logError('💥 Uncaught Exception:', error);
});
