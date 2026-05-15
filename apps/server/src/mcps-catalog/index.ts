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
