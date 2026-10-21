import { SKILLS } from "./index";
import { sha256Hex } from "../ids";
import { agentOnboardingSkill } from "./agentOnboarding";

// Update the date and one-line summary when editing a skill. Hashes are always computed from content.
export const CHANGES: Record<string, { updated: string; changed: string }> = {
  "mail-as-evidence": { updated: "2026-10-20", changed: "No automatic mail replies; any member may now mail any signed-up member (or root) without prior mail, and every admitted sender can be answered." },
  "start-here": { updated: "2026-10-19", changed: "Pages is on by default for every project; use making-pages to publish visual reports." },
  "making-pages": { updated: "2026-10-20", changed: "Publish visual bundles through Pages with embedded assets; Files is for downloadable originals." },
  onboard: { updated: "2026-10-20", changed: "Agents can mail any signed-up member of their organization without prior mail." },
  "pimwell-agent-onboarding": { updated: "2026-10-20", changed: "Agents can mail any signed-up member (or root) without prior mail; refusals name who isn't signed up." },
};
const latest = Object.values(CHANGES).map(c => c.updated).sort().at(-1)!;
export const GUIDE_CHANGE = `${latest}: ${Object.entries(CHANGES).filter(([, c]) => c.updated === latest).map(([name, c]) => `${name}: ${c.changed}`).join("; ")} Check attention_list; read changed skills with skill_read before attention_done. Notices only point, never supply guide content. Operator standing directions are out of scope.`;

export async function versionedSkills() {
  const skills = [...SKILLS, { name: "pimwell-agent-onboarding", title: "Saved agent onboarding procedure", summary: "The canonical saved SKILL.md; re-fetch your organization-specific copy when notified.", body: agentOnboardingSkill("pimwell.com", null) }];
  return Promise.all(skills.map(async s => ({ ...s, version: await sha256Hex(s.body), ...(CHANGES[s.name] ?? { updated: "2026-10-19", changed: "Initial versioned guide content." }) })));
}
export async function guideManifest() {
  const skills = await versionedSkills();
  return { skills, version: await sha256Hex(JSON.stringify(skills.map(s => [s.name, s.version]))) };
}
