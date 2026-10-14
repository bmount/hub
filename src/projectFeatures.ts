import { badRequest } from "./errors";

export type ProjectFeature = "docket" | "repo" | "wiki" | "knowledge" | "files" | "people";
/** Project capabilities, shared by pages, verbs and project-scoped tool discovery. */
export const PROJECT_FEATURES = {
  repo: ["docket", "repo", "files"],
  tracker: ["docket"],
  wiki: ["wiki", "files"],
  workspace: ["docket", "wiki", "knowledge", "files", "people"],
} as const satisfies Record<string, readonly ProjectFeature[]>;
export const PROJECT_KINDS = Object.keys(PROJECT_FEATURES);
export const FEATURE_LABELS: Record<ProjectFeature, string> = {
  docket: "Docket", repo: "Repository", wiki: "Wiki pages", knowledge: "Knowledge base", files: "Files", people: "People",
};
export function projectFeatures(kind: string): readonly ProjectFeature[] {
  return PROJECT_FEATURES[kind as keyof typeof PROJECT_FEATURES] ?? [];
}
export function requireProjectFeature(project: { kind: string; slug: string }, feature: ProjectFeature): void {
  if (!projectFeatures(project.kind).includes(feature)) throw badRequest(`Project "${project.slug}" (${project.kind}) does not support ${FEATURE_LABELS[feature]}.`);
}
