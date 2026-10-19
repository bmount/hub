import { badRequest } from "./errors";

export type ProjectFeature = "docket" | "repo" | "wiki" | "knowledge" | "files" | "people" | "pages";
/** Project capabilities, shared by pages, verbs and project-scoped tool discovery. */
export const PROJECT_FEATURES = {
  repo: ["docket", "repo", "files", "pages"],
  tracker: ["docket", "pages"],
  wiki: ["wiki", "files", "pages"],
  workspace: ["docket", "wiki", "knowledge", "files", "people", "pages"],
} as const satisfies Record<string, readonly ProjectFeature[]>;
export const PROJECT_KINDS = Object.keys(PROJECT_FEATURES);
export const FEATURE_LABELS: Record<ProjectFeature, string> = {
  docket: "Docket", repo: "Repository", wiki: "Wiki pages", knowledge: "Knowledge base", files: "Files", people: "People", pages: "Pages",
};
export function projectFeatures(project: { parts?: string }): readonly ProjectFeature[] {
  return JSON.parse(project.parts ?? "[]") as ProjectFeature[];
}
export function requireProjectFeature(project: { kind: string; slug: string; parts?: string; path?: string }, feature: ProjectFeature): void {
  if (!projectFeatures(project).includes(feature)) throw badRequest(`Project "${project.slug}" does not support ${FEATURE_LABELS[feature]}. Add it with project_update {project: "${project.path ?? project.slug}", add: ["${feature}"]}.`);
}
