export type SkillCatalogEntry = {
  id: string;
  name: string;
  description: string;
  tags: string[];
  homepage?: string;
};

export const SKILLS_CATALOG: SkillCatalogEntry[] = [
  {
    id: "sentry-triage",
    name: "Sentry Triage Enhancer",
    description:
      "Augments the Haiku triage step with breadcrumb interpretation and likely-cause hints derived from the stack frame.",
    tags: ["triage", "sentry"],
  },
  {
    id: "pr-reviewer",
    name: "PR Self-Reviewer",
    description:
      "Have the agent run a structured self-review of its own diff (small/large change, test coverage, blast radius) before opening the PR.",
    tags: ["pr", "review"],
  },
];
