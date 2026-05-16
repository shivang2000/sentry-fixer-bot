export type CatalogEntry = {
  id: string;
  name: string;
  description: string;
  transport: "stdio" | "http" | "sse";
  command?: string;
  argsTemplate: string[];
  envSchema: Record<string, { required: boolean; secret: boolean; description: string }>;
  tags: string[];
  homepage: string;
};

export const CATALOG: CatalogEntry[] = [
  {
    id: "sentry",
    name: "Sentry",
    description: "Query Sentry issues, events, replays, and breadcrumbs from inside an agent run.",
    transport: "stdio",
    command: "npx",
    argsTemplate: ["-y", "@sentry/mcp-server"],
    envSchema: {
      SENTRY_API_TOKEN: {
        required: true,
        secret: true,
        description: "Internal integration token with read access to issues + events",
      },
      SENTRY_ORG_SLUG: {
        required: true,
        secret: false,
        description: "e.g. acme-corp",
      },
    },
    tags: ["observability", "sentry"],
    homepage: "https://github.com/getsentry/sentry-mcp",
  },
  {
    id: "github",
    name: "GitHub",
    description: "Read issues, PRs, and repos. Most popular MCP server.",
    transport: "stdio",
    command: "npx",
    argsTemplate: ["-y", "@modelcontextprotocol/server-github"],
    envSchema: {
      GITHUB_PERSONAL_ACCESS_TOKEN: {
        required: true,
        secret: true,
        description: "Token with read access to your repos",
      },
    },
    tags: ["dev"],
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/github",
  },
  {
    id: "filesystem",
    name: "Filesystem",
    description: "Read files under a configured allowlist path.",
    transport: "stdio",
    command: "npx",
    argsTemplate: ["-y", "@modelcontextprotocol/server-filesystem", "/var/lib/sfb/agent-fs"],
    envSchema: {},
    tags: ["dev"],
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
  },
];
