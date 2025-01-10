import { graphql } from "@octokit/graphql";
import type { RateLimit } from "@octokit/graphql-schema";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!GITHUB_TOKEN) {
    throw new Error("Missing required environment variables (GITHUB_TOKEN).");
}

const graphqlWithAuth = graphql.defaults({
    headers: {
        authorization: `token ${GITHUB_TOKEN}`,
    },
});

async function checkRateLimit() {
    try {
        const { rateLimit }: { rateLimit: RateLimit } = await graphqlWithAuth(`
      query getRateLimit {
        rateLimit {
          remaining
          limit
          cost
          resetAt
          used
        }
      }
    `);

        console.log('\n=== GitHub API Rate Limit Status ===');
        console.log(`Used: ${rateLimit.used}/${rateLimit.limit}`);
        console.log(`Remaining: ${rateLimit.remaining}/${rateLimit.limit}`);
        console.log(`Resets at: ${new Date(rateLimit.resetAt).toLocaleString()}`);
        console.log('==================================\n');

    } catch (error) {
        console.error('❌ Error checking rate limit:', error);
    }
}

checkRateLimit();
