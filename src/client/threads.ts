import type { WithoutSystemFields } from "convex/server";
import type { ThreadDoc } from "../component/schema.js";
import type { AgentComponent, RunMutationCtx, RunQueryCtx } from "./types.js";

/**
 * Create a thread to store messages with an Agent.
 * @param ctx The context from a mutation or action.
 * @param component The Agent component, usually `components.agent`.
 * @param args The associated thread metadata.
 * @returns The id of the created thread.
 */
export async function createThread(
  ctx: RunMutationCtx,
  component: AgentComponent,
  args?: { userId?: string | null; title?: string; summary?: string },
) {
  const { _id: threadId } = await ctx.runMutation(
    component.threads.createThread,
    {
      userId: args?.userId ?? undefined,
      title: args?.title,
      summary: args?.summary,
    },
  );
  return threadId;
}

/**
 * Get the metadata for a thread.
 * @param ctx A ctx object from a query, mutation, or action.
 * @param args.threadId The thread to get the metadata for.
 * @returns The metadata for the thread.
 */
export async function getThreadMetadata(
  ctx: RunQueryCtx,
  component: AgentComponent,
  args: { threadId: string },
): Promise<ThreadDoc> {
  const thread = await ctx.runQuery(component.threads.getThread, {
    threadId: args.threadId,
  });
  if (!thread) {
    throw new Error("Thread not found");
  }
  return thread;
}

export async function updateThreadMetadata(
  ctx: RunMutationCtx,
  component: AgentComponent,
  args: { threadId: string; patch: Partial<WithoutSystemFields<ThreadDoc>> },
) {
  return ctx.runMutation(component.threads.updateThread, {
    threadId: args.threadId,
    patch: args.patch,
  });
}

/**
 * Search for threads by title, paginated.
 * @param ctx The context passed from the query/mutation/action.
 * @returns The threads matching the search, paginated.
 */
export async function searchThreadTitles(
  ctx: RunQueryCtx,
  component: AgentComponent,
  {
    userId,
    query,
    limit,
  }: { userId?: string | undefined; query: string; limit?: number },
): Promise<ThreadDoc[]> {
  return ctx.runQuery(component.threads.searchThreadTitles, {
    userId,
    query,
    limit: limit ?? 10,
  });
}
