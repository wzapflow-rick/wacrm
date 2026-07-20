import type { DbClient } from "@/lib/db/client";
import type { Pipeline } from "@/types";

/**
 * Spec-defined default stages seeded for every new pipeline (name + color +
 * position). Kept server-side so the seed is identical whether it happens on
 * first load (seed-if-empty) or on explicit pipeline creation.
 */
export const SPEC_DEFAULT_STAGES = [
  { name: "New Lead", color: "#3b82f6", position: 0 },
  { name: "Qualified", color: "#eab308", position: 1 },
  { name: "Proposal Sent", color: "#f97316", position: 2 },
  { name: "Negotiation", color: "#8b5cf6", position: 3 },
  { name: "Won", color: "#22c55e", position: 4 },
] as const;

/**
 * Creates a pipeline plus its default stages for an account. Runs the two
 * inserts against the request-scoped shim client. Returns the new pipeline.
 */
export async function createPipelineWithStages(
  db: DbClient,
  params: { accountId: string; userId: string; name: string },
): Promise<Pipeline | null> {
  const { data: pipeline, error } = await db
    .from("pipelines")
    .insert({
      user_id: params.userId,
      account_id: params.accountId,
      name: params.name,
    })
    .select()
    .single();

  if (error || !pipeline) return null;

  const stageRows = SPEC_DEFAULT_STAGES.map((s) => ({
    pipeline_id: (pipeline as Pipeline).id,
    name: s.name,
    color: s.color,
    position: s.position,
  }));
  await db.from("pipeline_stages").insert(stageRows);

  return pipeline as Pipeline;
}
