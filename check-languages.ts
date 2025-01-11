import { graphql } from "@octokit/graphql";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!GITHUB_TOKEN) {
    throw new Error("Missing required environment variables (GITHUB_TOKEN).");
}

const graphqlWithAuth = graphql.defaults({
    headers: {
        authorization: `token ${GITHUB_TOKEN}`,
        'user-agent': 'neptun-repository-fetcher/1.0',
    },
});

async function fetchLanguagesWithPopularRepos() {
    const result: {
        search: {
            repositories: Array<{
                nameWithOwner: string;
                primaryLanguage?: {
                    name: string;
                } | null;
                stargazerCount: number;
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
            nameWithOwner
            primaryLanguage {
              name
            }
            stargazerCount
          }
        }
      }
    }
  `);

    const languages = new Map<string, {
        count: number;
        repositories: Array<{
            name: string;
            stars: number;
        }>;
    }>();

    for (const repo of result.search.repositories) {
        if (repo?.primaryLanguage?.name) {
            const langData = languages.get(repo.primaryLanguage.name) || {
                count: 0,
                repositories: []
            };

            langData.count++;
            langData.repositories.push({
                name: repo.nameWithOwner,
                stars: repo.stargazerCount
            });

            languages.set(repo.primaryLanguage.name, langData);
        }
    }

    return Array.from(languages.entries())
        .map(([name, data]) => ({
            name,
            repositoryCount: data.count,
            repositories: data.repositories
        }))
        .sort((a, b) => b.repositoryCount - a.repositoryCount);
}

async function main() {
    try {
        console.log('🔍 Fetching languages with popular repositories...\n');
        const languages = await fetchLanguagesWithPopularRepos();

        console.log(`Found ${languages.length} languages in top 100 repositories:\n`);

        languages.forEach(lang => {
            console.log(`📚 ${lang.name} (${lang.repositoryCount} repositories):`);
            lang.repositories.forEach(repo => {
                console.log(`    ⭐ ${repo.name} (${repo.stars.toLocaleString()} stars)`);
            });
            console.log('');
        });
    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
}

main();
