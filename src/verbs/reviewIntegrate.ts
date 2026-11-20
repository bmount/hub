import type { Ctx } from "../auth/context";
import { artifactPush, repoOwnership } from "../code/artifactPush";
import { ArtifactsRest, artifactNamespace } from "../code/artifactsRest";
import { codeAuth } from "../code/ardi";
import { authorizeGit } from "../code/gitAccess";
import { refAllowed, ZERO_OID, type RefOutcome } from "../code/gitProtocol";
import { refUpdateBody, validationRefs } from "../code/gitValidation";
import { conflict, forbidden } from "../errors";
import { ulid } from "../ids";
import { reqString } from "./params";
import { reviewRef } from "./review";
import { defineVerb } from "./table";

type Review = Awaited<ReturnType<typeof reviewRef>>;
const oid = (s: string | null): s is string => !!s && /^[0-9a-f]{40}$/.test(s) && s !== ZERO_OID;

export const reviewIntegrate = defineVerb({
  name: "review.integrate", kind: "command", scope: "tenant", minRole: "member", freshProofMinutes: null,
  summary: "Fast-forward an approved review's base to its reviewed head. Both branches must still have their recorded tips. Retry the same review to reconcile an interrupted merge.",
  mcp: { scope: "write", destructive: false, title: "Merge approved review", input: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } },
  parse: i => ({ id: reqString(i, "id", { max: 160 }) }),
  run: async (ctx, p) => {
    const r = await reviewRef(ctx, p.id);
    const ref = `${r.slug}!${r.number}`, path = r.slug + (r.repo ? `/${r.repo}` : "");
    const source = `refs/heads/${r.branch}`, target = `refs/heads/${r.base}`;
    if (ctx.env.GIT_BACKEND !== "artifacts") throw conflict("integration requires an Artifacts repository");
    const credential = await codeAuth(ctx);
    const authorize = async () => {
      const g = await authorizeGit(ctx.env, credential, ctx.tenant!.slug, path);
      if (!g?.write || !g.artifacts || !g.repository || g.identity.id !== ctx.identity!.id || g.tenant.id !== ctx.tenant!.id ||
        g.project.id !== r.project_id || (g.repository.is_default ? "" : g.repository.name) !== r.repo ||
        (ctx.mcpProject && ctx.mcpProject.id !== g.project.id) || !refAllowed(target, g.refPrefixes)) throw forbidden("no Git write access to the reviewed repository");
      return g;
    };
    const grant = await authorize();
    if (r.status === "closed" && r.merged_oid) return { ref, status: "closed", merged_oid: r.merged_oid };
    if (r.status !== "approved") throw conflict("all reviewers must approve before integration");
    if (!oid(r.head_oid) || !oid(r.base_oid) || r.base_oid === r.head_oid || source === target || !refAllowed(source))
      throw conflict("request a new review between two different branch tips");
    const update = { oldOid: r.base_oid, newOid: r.head_oid, ref: target };
    const api = new ArtifactsRest(ctx.env), ns = artifactNamespace(grant.tenant.slug), repo = grant.repository!.storage_name;
    const info = await api.info(ns, repo);
    if (info.description !== repoOwnership(grant.tenant.id, grant.project.id)) throw conflict("repository ownership mismatch");
    if (info.read_only) throw forbidden("repository is read-only");
    const tips = () => validationRefs(api, ns, repo, [source, target]);
    const check = async () => {
      const refs = await tips();
      if (refs.get(source) !== update.newOid || refs.get(target) !== update.oldOid) throw conflict("a reviewed branch moved; request a new review");
    };

    // D1 and receive-pack cannot commit together. The durable push ID freezes verdicts
    // and both refs until a definitive report, or until a retry reads back the target.
    const finish = async (push: string) => {
      const row = await ctx.db.prepare(`SELECT state, published_json, created_at FROM git_push WHERE id = ? AND tenant_id = ? AND project_id = ? AND repo = ?`)
        .bind(push, grant.tenant.id, grant.project.id, repo).first<{ state: string; published_json: string | null; created_at: number }>();
      if (!row) throw conflict("cannot reconcile the recorded Git push");
      const publication = (JSON.parse(row.published_json ?? "[]") as RefOutcome[]).find(u => u.ref === target && u.oldOid === update.oldOid && u.newOid === update.newOid);
      let accepted = row.state === "complete" && publication?.outcome === "ok";
      if (!["complete", "refused"].includes(row.state)) {
        accepted = !!publication && (row.state === "publishing" || row.state === "unknown") && (await tips()).get(target) === update.newOid;
        // A client that timed out must not release a fence while storage can still publish.
        if (!accepted && Date.now() - row.created_at < 360_000) throw conflict("integration pending; retry this review after the six-minute Git deadline");
      }
      if (!accepted) {
        await ctx.db.prepare("UPDATE review SET merge_push_id = NULL WHERE id = ? AND merge_push_id = ?").bind(r.id, push).run();
        throw conflict("Git did not fast-forward the reviewed base; check the branch tips and approvals");
      }
      const [,, closed] = await ctx.db.batch([
        // For a lost report the fenced readback also restores the ordinary Git timeline.
        ctx.db.prepare(`UPDATE git_push SET state = 'complete', published_json = ?1, outcomes_json = ?1, completed_at = ?2
          WHERE id = ?3 AND state = 'unknown' AND EXISTS (SELECT 1 FROM review WHERE id = ?4 AND merge_push_id = ?3)`)
          .bind(JSON.stringify([{ ...update, outcome: "ok" }]), Date.now(), push, r.id),
        ctx.db.prepare(`INSERT INTO event (id, tenant_id, identity_id, session_id, kind, target_kind, target_id, summary, created_at)
          SELECT ?, p.tenant_id, p.identity_id, p.session_id, 'review.integrate', 'review', r.id, ?, ? FROM review r JOIN git_push p ON p.id = r.merge_push_id WHERE r.id = ? AND p.id = ?`)
          .bind(ulid(), `Merged ${ref}: ${r.branch} into ${r.base} at ${update.newOid}`, Date.now(), r.id, push),
        ctx.db.prepare("UPDATE review SET status = 'closed', merged_oid = head_oid, merge_push_id = NULL, updated_at = ? WHERE id = ? AND merge_push_id = ?").bind(Date.now(), r.id, push),
      ]);
      if (!closed!.meta.changes && (await reviewRef(ctx, r.id)).merged_oid !== update.newOid) throw conflict("review integration changed; check the recorded push");
      return { ref, status: "closed", merged_oid: update.newOid };
    };
    if (r.merge_push_id) return finish(r.merge_push_id);
    await check();
    const id = crypto.randomUUID();
    const request = new Request("https://git.internal/git-receive-pack", { method: "POST", headers: { "content-type": "application/x-git-receive-pack-request" }, body: await refUpdateBody([update]) });
    const result = await artifactPush(request, ctx.env, grant, api, async () => {
      const current = await authorize();
      if (current.repository!.storage_name !== repo) throw conflict("repository changed");
      await claimIntegration(ctx, r, id, repo, source, target);
      await check(); // Both tips are now fenced against new Git publications.
      return current;
    }, ctx.waitUntil, { pushId: id, reviewId: r.id });
    await result.body?.cancel();
    return finish(id);
  },
});

async function claimIntegration(ctx: Ctx, r: Review, push: string, repo: string, source: string, target: string) {
  const changed = await ctx.db.prepare(`UPDATE review SET merge_push_id = ? WHERE id = ? AND tenant_id = ? AND status = 'approved' AND merge_push_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM review other WHERE other.project_id = review.project_id AND other.repo = review.repo AND other.merge_push_id IS NOT NULL
      AND (other.branch IN (review.branch, review.base) OR other.base IN (review.branch, review.base)))
    AND EXISTS (SELECT 1 FROM review_reviewer WHERE review_id = review.id)
    AND NOT EXISTS (SELECT 1 FROM review_reviewer WHERE review_id = review.id AND (identity_id = review.author_id OR verdict IS NOT 'approve' OR head_oid IS NOT review.head_oid))
    AND NOT EXISTS (SELECT 1 FROM git_push p, json_each(p.published_json) u WHERE p.project_id = review.project_id AND p.repo = ?
      AND p.state IN ('publishing','unknown') AND p.created_at > ? AND json_extract(u.value, '$.ref') IN (?, ?))`)
    .bind(push, r.id, ctx.tenant!.id, repo, Date.now() - 360_000, source, target).run();
  if (!changed.meta.changes) throw conflict("review no longer eligible or another publication is in progress");
}
