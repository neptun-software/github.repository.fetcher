import { graphql } from "@octokit/graphql";
import type {
    SearchResultItemConnection,
    RateLimit,
    Repository,
} from "@octokit/graphql-schema";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const DATA_DIR = "data/configuration";
const LOG_FILE = join(DATA_DIR, "error.log");

if (!GITHUB_TOKEN) {
    throw new Error("Missing required environment variables (GITHUB_TOKEN).");
}

const graphqlWithAuth = graphql.defaults({
    headers: {
        authorization: `token ${GITHUB_TOKEN}`,
        'user-agent': 'neptun-repository-fetcher/1.0',
    },
});

// Configuration files to search for
const CONFIG_FILES = {
    javascript: [
        'package\\.json$',
        '\\.npmrc$',
        '\\.eslintrc(\\.js|\\.json)?$',
        '\\.prettierrc(\\.js|\\.json)?$',
        'tsconfig(\\..*?)?\\.json$',
        '(webpack|rollup|babel|jest|vite|next|nuxt|svelte|astro|remix|gatsby|angular|vue|qwik|solid|parcel|snowpack|esbuild|turbopack|storybook|tailwind|postcss|vitest|cypress|playwright|commitlint|stylelint|prisma|nodemon|pm2|grunt|gulp)\\.config\\.(js|ts|cjs|mjs)$',
        '\\.babelrc$',
        'vercel\\.json$',
        'netlify\\.toml$',
        'firebase\\.json$',
        'now\\.json$',
        'deno\\.json$',
        'nx\\.json$',
        'lerna\\.json$',
        'pnpm-workspace\\.yaml$'
    ],
    python: [
        'setup\\.py$',
        'pyproject\\.toml$',
        '\\.pylintrc$',
        '(pytest|tox|mypy|flake8|black|isort|coverage|sphinx|uvicorn|gunicorn)\\.ini$',
        '\\.?pre-commit-config\\.yaml$',
        'pyrightconfig\\.json$'
    ],
    docker: [
        '(?:^|/)Dockerfile(?:\\..*)?$',
        'docker-compose(?:\\.[^/]*?)?\\.ya?ml$',
        '\\.dockerignore$'
    ],
    kubernetes: [
        '^(?:k8s|kube|kubernetes)?/?(?:base|overlays)?/?(deployment|service|ingress|configmap|secret|statefulset|daemonset|job|cronjob|persistentvolume|persistentvolumeclaim|role|rolebinding|serviceaccount|namespace|networkpolicy|poddisruptionbudget|horizontalpodautoscaler)\\.ya?ml$',
        '^values(?:-.*?)?\\.yaml$',
        '^Chart\\.yaml$',
        'kustomization\\.ya?ml$',
        'skaffold\\.ya?ml$',
        'helmfile\\.ya?ml$'
    ],
    git: [
        '\\.git(ignore|attributes|config|modules)$'
    ],
    ci: [
        '\\.travis\\.yml$',
        '\\.gitlab-ci\\.yml$',
        'azure-pipelines\\.yml$',
        '^\\.github/workflows/.*\\.ya?ml$',
        'Jenkinsfile(?:\\..*)?$',
        'circle\\.yml$',
        'bitbucket-pipelines\\.yml$',
        'appveyor\\.yml$',
        '\\.drone\\.yml$',
        'cloudbuild\\.ya?ml$',
        'buildkite\\.ya?ml$',
        'codeship-.*\\.yml$'
    ],
    terraform: [
        '.*\\.tf$',
        '.*\\.tfvars$',
        'terragrunt\\.hcl$'
    ],
    rust: [
        'Cargo\\.toml$',
        '\\.cargo/config(?:\\.toml)?$',
        'rustfmt\\.toml$',
        'clippy\\.toml$'
    ],
    go: [
        'go\\.mod$',
        '\\.golangci\\.ya?ml$',
        'goreleaser\\.ya?ml$'
    ],
    ruby: [
        'Gemfile$',
        '\\.rubocop(\\..*?)?\\.ya?ml$',
        'config/.*\\.(rb|ya?ml)$',
        '\\.ruby-version$'
    ],
    java: [
        'pom\\.xml$',
        'build\\.gradle(\\.kts)?$',
        'settings\\.gradle(\\.kts)?$',
        'application\\.(properties|ya?ml)$',
        '\\.mvn/.*\\.xml$'
    ],
    php: [
        'composer\\.json$',
        '\\.php-version$',
        'phpunit\\.xml$',
        'wp-config\\.php$',
        '\\.htaccess$',
        'php\\.ini$'
    ],
    database: [
        '(?:^|/)(?:my|pg|maria|mongo|redis)?\\.?conf$',
        'sequelize(?:\\..*?)?\\.js$',
        'knexfile\\.js$',
        'schema\\.prisma$',
        'typeorm\\.config\\.(js|ts)$',
        'liquibase\\.properties$',
        'flyway\\.conf$'
    ],
    security: [
        '\\.?auth(?:\\..*?)?\\.ya?ml$',
        'oauth2?\\.ya?ml$',
        'cors\\.ya?ml$',
        'security\\.ya?ml$',
        'ssl\\.conf$',
        'keycloak\\.json$',
        'auth0\\.ya?ml$',
        'saml.*\\.xml$',
        'oidc.*\\.json$',
        'ldap.*\\.conf$'
    ],
    monitoring: [
        'prometheus\\.ya?ml$',
        'grafana\\.ini$',
        'logstash\\.conf$',
        'filebeat\\.ya?ml$',
        'fluentd?\\.conf$',
        'jaeger\\.ya?ml$',
        'elastic.*\\.ya?ml$'
    ],
    mobile: [
        'AndroidManifest\\.xml$',
        'Info\\.plist$',
        'capacitor\\.config\\.(json|ts)$',
        'config\\.xml$',
        'expo\\.config\\.(js|ts)$'
    ],
    ide: [
        '\\.editorconfig$',
        '\\.sublime-project$',
        '\\.code-workspace$',
        'omnisharp\\.json$',
        'jsconfig\\.json$'
    ],
    cloud: [
        'serverless\\.ya?ml$',
        'template\\.ya?ml$',
        'cdk\\.json$',
        'pulumi\\.ya?ml$',
        'fly\\.toml$',
        'railway\\.toml$',
        'render\\.ya?ml$',
        'heroku\\.ya?ml$',
        'gcp-.*\\.ya?ml$',
        'azure-.*\\.json$'
    ],
    lint: [
        '\\.eslint.*$',
        '\\.prettier.*$',
        '\\.stylelint.*$',
        '\\.markdownlint.*$',
        '\\.yamllint.*$',
        '\\.hadolint.*$',
        '\\.shellcheck.*$',
        '\\.commitlint.*$',
        'tslint\\.json$',
        'lint-staged\\..*$'
    ],
    test: [
        'jest\\.config\\.(js|ts|json)$',
        'vitest\\.config\\.(js|ts)$',
        'karma\\.conf\\.js$',
        'cypress\\.config\\.(js|ts)$',
        'playwright\\.config\\.(js|ts)$',
        'ava\\.config\\.(js|ts)$',
        'mocha\\.(rc|opts)$',
        'wdio\\.conf\\.js$'
    ],
    api: [
        'swagger\\.ya?ml$',
        'openapi\\.ya?ml$',
        'api-.*\\.ya?ml$',
        'graphql\\.config\\.(js|ts|json)$',
        'apollo\\.config\\.(js|ts)$'
    ],
    webserver: [
        'nginx\\.conf$',
        'apache2?\\.conf$',
        'httpd\\.conf$',
        'lighttpd\\.conf$',
        'caddy(file)?$',
        'traefik\\.ya?ml$',
        'haproxy\\.cfg$',
        'sites?-?(available|enabled)/.*\\.conf$'
    ],
    container: [
        'containerd\\.toml$',
        'buildah\\.ya?ml$',
        'podman.*\\.ya?ml$',
        'kind\\.ya?ml$',
        'microk8s\\.ya?ml$',
        'k3s\\.ya?ml$',
        'rancher\\.ya?ml$',
        'openshift\\.ya?ml$'
    ],
    messaging: [
        'rabbitmq\\.conf$',
        'kafka.*\\.properties$',
        'activemq\\.xml$',
        'mosquitto\\.conf$',
        'nats.*\\.conf$',
        'zeromq.*\\.conf$',
        'pulsar.*\\.conf$'
    ],
    search: [
        'elasticsearch\\.ya?ml$',
        'solr\\.xml$',
        'sphinx\\.conf$',
        'opensearch\\.ya?ml$',
        'meilisearch\\.ya?ml$',
        'typesense\\.ya?ml$'
    ],
    cdn: [
        'cloudfront.*\\.ya?ml$',
        'fastly\\.toml$',
        'akamai\\.ya?ml$',
        'cloudflare.*\\.ya?ml$',
        'cdn.*\\.conf$'
    ],
    analytics: [
        'ga4?\\.json$',
        'matomo\\.config\\..*$',
        'plausible\\.config\\..*$',
        'umami\\.config\\..*$',
        'analytics\\.ya?ml$'
    ],
    cms: [
        'wp-config\\.php$',
        'drupal.*\\.ya?ml$',
        'ghost\\.config\\..*$',
        'strapi\\.config\\.js$',
        'contentful\\.config\\..*$',
        'sanity\\.config\\..*$'
    ],
    backup: [
        'restic\\.ya?ml$',
        'duplicity\\.conf$',
        'borgmatic\\.ya?ml$',
        'rclone\\.conf$',
        'rsnapshot\\.conf$'
    ],
    ai: [
        'model-?card\\.ya?ml$',
        'huggingface\\.ya?ml$',
        'transformers\\.config\\.json$',
        'pytorch\\.config\\.ya?ml$',
        'tensorflow\\.config\\.ya?ml$',
        'keras\\.config\\.ya?ml$',
        'mlflow\\.ya?ml$',
        'wandb\\.ya?ml$'
    ],
    game: [
        'unity\\.config\\.json$',
        'godot\\.config\\.tres$',
        'unreal\\.config\\.ini$',
        'game\\.config$',
        'ProjectSettings/.*\\.asset$'
    ],
    embedded: [
        'platformio\\.ini$',
        'arduino\\.json$',
        'esp.*\\.config\\.json$',
        'raspberry.*\\.conf$',
        'micropython\\.config\\.py$',
        'zephyr/.*\\.conf$',
        'stm32.*\\.ioc$'
    ],
    blockchain: [
        'hardhat\\.config\\.(js|ts)$',
        'truffle-config\\.(js|ts)$',
        'foundry\\.toml$',
        'anchor\\.toml$',
        'substrate\\.config\\.json$',
        'web3\\.config\\.(js|ts)$',
        'ganache\\.config\\.json$'
    ],
    desktop: [
        'electron\\.config\\.(js|json)$',
        'tauri\\.conf\\.json$',
        'wails\\.json$',
        'neutralino\\.config\\.json$',
        'gtk.*\\.ini$',
        'qt.*\\.conf$',
        'wxwidgets\\.config\\.xml$'
    ],
    networking: [
        'hosts$',
        'resolv\\.conf$',
        'interfaces$',
        'dhcpd?\\.conf$',
        'named\\.conf$',
        'bind\\.conf$',
        'iptables\\.conf$',
        'wireguard/.*\\.conf$',
        'openvpn/.*\\.conf$',
        'dnsmasq\\.conf$'
    ],
    virtualization: [
        'vagrantfile$',
        'virtualbox\\.conf$',
        'vmware\\.conf$',
        'hyperv\\.conf$',
        'qemu\\.conf$',
        'libvirt\\.conf$',
        'proxmox\\.conf$',
        'xen\\.conf$'
    ],
    iot: [
        'home-?assistant\\.ya?ml$',
        'zigbee2mqtt\\.ya?ml$',
        'tasmota\\.config\\..*$',
        'esphome\\.ya?ml$',
        'node-red\\.config\\..*$',
        'openhab\\.config\\..*$',
        'mqtt\\.conf$'
    ]
};

type FileMetadata = {
    timestamp: number;
    repository: string;
    path: string;
    category: string;
    stars: number;
    content: string;
    size?: number;
};

type ConfigCategory = keyof typeof CONFIG_FILES;

function isValidCategory(category: string): category is ConfigCategory {
    return category in CONFIG_FILES;
}

async function logError(message: string, error?: any) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n${error ? `Error: ${JSON.stringify(error, null, 2)}\n` : ''}\n`;

    await mkdir(DATA_DIR, { recursive: true });
    const logFile = Bun.file(LOG_FILE);
    const writer = logFile.writer();
    writer.write(logMessage);
    writer.flush();
    writer.end();

    console.error(message);
    if (error) console.error(error);
}

async function saveFile(category: string, filename: string, metadata: FileMetadata) {
    // check if file is matching the regex
    if (!isValidCategory(category)) {
        console.log(`⚠️ Skipping ${filename} - invalid category ${category}`);
        return;
    }

    if (!CONFIG_FILES[category].some(pattern => new RegExp(pattern).test(filename))) {
        console.log(`⚠️ Skipping ${filename} - does not match the regex for ${category}`);
        return;
    }

    const dir = join(DATA_DIR, category);
    await mkdir(dir, { recursive: true });

    // Sanitize filename to be safe for filesystem
    const sanitizedFilename = filename.replace(/[/\\?%*:|"<>]/g, '-');
    const repoName = metadata.repository.replace('/', '--');
    const path = join(dir, `${sanitizedFilename}--${repoName}.json`);

    await writeFile(path, JSON.stringify(metadata, null, 2));
    console.log(`✅ Saved ${filename} from ${metadata.repository} to ${path}`);
}

async function searchFiles(filename: string, category: string) {
    let hasNextPage = true;
    let cursor: string | null = null;

    try {
        while (hasNextPage) {
            // Use GitHub's path search with regex - matches files in any directory
            // stars:>1000 archived:false (license:MIT OR license:Apache-2.0 OR license:BSD-3-Clause OR license:BSD-2-Clause OR license:Unlicense) sort:stars-desc sort:updated-desc
            const searchQuery = `path:/${filename}/`
                .replace(/\\/g, '\\\\')  // Escape backslashes for GraphQL string
                .replace(/"/g, '\\"');   // Escape quotes for GraphQL string
            console.log(`\nSearch query: ${searchQuery}`);

            try {
                // https://docs.github.com/en/search-github/github-code-search/understanding-github-code-search-syntax
                const result = await graphqlWithAuth(`
                    query searchConfigFiles($cursor: String) {
                        search(
                            query: "${searchQuery}"
                            type: REPOSITORY
                            first: 1
                            after: $cursor
                        ) {
                            repositoryCount
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
                    }`, {
                    cursor,
                }).catch((error: { errors?: Array<{ message?: string }>; response?: { data?: any } }) => {
                    // Check if this is just a "Could not resolve file" error
                    if (error.errors?.every(e => e.message?.includes('Could not resolve file'))) {
                        return error.response?.data;
                    }
                    throw error; // Re-throw other errors
                }) as { search: SearchResultItemConnection; rateLimit: RateLimit };

                if (!result?.search) {
                    console.log('No search results returned');
                    break;
                }

                console.log('\n=== Search Results ===');
                console.log(`Total repositories found: ${result.search.repositoryCount}`);
                console.log(`Nodes in current page: ${result.search.nodes?.length || 0}`);

                hasNextPage = result.search.pageInfo.hasNextPage;
                cursor = result.search.pageInfo.endCursor ?? null;

                if (!result.search.nodes || result.search.nodes.length === 0) {
                    console.log('No repositories found with this file');
                    break;
                }

                let savedCount = 0;
                for (const node of result.search.nodes) {
                    const repo = node as Repository;
                    if (!repo || !repo.nameWithOwner || !repo.defaultBranchRef?.target) {
                        console.log(`⚠️ Skipping ${repo?.nameWithOwner || 'unknown'} - repository not accessible`);
                        continue;
                    }

                    const commit = repo.defaultBranchRef.target as { tree?: { entries?: Array<{ name: string; type: string; object?: { text?: string } }> } };
                    const entries = commit.tree?.entries;
                    if (!entries || entries.length === 0) {
                        continue; // Skip silently as this is expected for some repos
                    }

                    for (const entry of entries) {
                        if (entry.type !== 'blob' || !entry.object?.text || typeof entry.object.text !== 'string') {
                            continue;
                        }

                        // Skip non-Latin content
                        if (!isMainlyLatin(entry.object.text)) {
                            console.log(`⚠️ Skipping ${repo.nameWithOwner}/${entry.name} - non-Latin content`);
                            continue;
                        }

                        const metadata: FileMetadata = {
                            timestamp: Date.now(),
                            repository: repo.nameWithOwner,
                            path: entry.name,
                            category,
                            stars: repo.stargazerCount,
                            content: entry.object.text
                        };

                        await saveFile(category, entry.name, metadata);
                        savedCount++;
                    }
                }

                console.log(`\n📊 Summary for this page:`);
                console.log(`Repositories processed: ${result.search.nodes.length}`);
                console.log(`Files saved: ${savedCount}`);

                // Check rate limit
                if (result.rateLimit?.remaining < (result.rateLimit?.cost || 1)) {
                    console.log('⚠️ Rate limit nearly exhausted, waiting for reset...');
                    const resetTime = new Date(result.rateLimit.resetAt);
                    const waitTime = resetTime.getTime() - Date.now() + 1000;
                    if (waitTime > 0) {
                        console.log(`Waiting ${Math.ceil(waitTime / 1000)} seconds for rate limit reset...`);
                        await new Promise(resolve => setTimeout(resolve, waitTime));
                    }
                } else {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            } catch (error) {
                await logError(`Error in search iteration for ${filename}:`, error);
                break; // Break the loop for this file on serious errors
            }
        }
    } catch (error) {
        await logError(`Error searching for ${filename}:`, error);
    }
}

async function main() {
    try {
        for (const [category, files] of Object.entries(CONFIG_FILES)) {
            console.log(`\n🔍 Processing ${category} configuration files...`);

            for (const filename of files) {
                console.log(`\n📦 Searching for ${filename}`);
                await searchFiles(filename, category);
            }
        }

        console.log('\n✅ Completed processing all configuration files');
    } catch (error) {
        console.error('❌ Fatal error:', error);
        process.exit(1);
    }
}

main();

process.on('uncaughtException', async (error) => {
    await logError('💥 Uncaught Exception:', error);
});

function isMainlyLatin(text: string): boolean {
    // Count Latin vs non-Latin characters
    let latinCount = 0;
    let nonLatinCount = 0;

    for (const char of text) {
        // Basic Latin letters (A-Z, a-z), numbers (0-9), and common punctuation
        if (/^[A-Za-z0-9\s.,!?@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~\n\r\t]$/.test(char)) {
            latinCount++;
        }
        // Extended Latin characters including all variations (accents, umlauts, etc.)
        else if (/^[\u00C0-\u024F\u1E00-\u1EFF]$/.test(char)) {
            latinCount++;
        }
        // Non-Latin characters
        else {
            nonLatinCount++;
        }
    }

    // If more than 50% of the characters are Latin, consider the text mainly Latin
    return latinCount > nonLatinCount;
}

