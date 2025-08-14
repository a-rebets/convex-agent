import type { ModelMessage } from "ai";
import type { PaginationOptions, PaginationResult } from "convex/server";
import type { MessageDoc } from "../component/schema.js";
import { validateVectorDimension } from "../component/vector/tables.js";
import type {
  Message,
  MessageEmbeddings,
  MessageStatus,
  MessageWithMetadata,
} from "../validators.js";
import { serializeMessage } from "./index.js";
import type { AgentComponent, RunMutationCtx, RunQueryCtx } from "./types.js";

/**
 * List messages from a thread.
 * @param ctx A ctx object from a query, mutation, or action.
 * @param component The agent component, usually `components.agent`.
 * @param args.threadId The thread to list messages from.
 * @param args.paginationOpts Pagination options (e.g. via usePaginatedQuery).
 * @param args.excludeToolMessages Whether to exclude tool messages.
 *   False by default.
 * @param args.statuses What statuses to include. All by default.
 * @returns The MessageDoc's in a format compatible with usePaginatedQuery.
 */
export async function listMessages(
  ctx: RunQueryCtx,
  component: AgentComponent,
  args: {
    threadId: string;
    paginationOpts: PaginationOptions;
    excludeToolMessages?: boolean;
    statuses?: MessageStatus[];
  },
): Promise<PaginationResult<MessageDoc>> {
  if (args.paginationOpts.numItems === 0) {
    return {
      page: [],
      isDone: true,
      continueCursor: args.paginationOpts.cursor ?? "",
    };
  }
  return ctx.runQuery(component.messages.listMessagesByThreadId, {
    order: "desc",
    ...args,
  });
}

export type SaveMessagesArgs = {
  threadId: string;
  userId?: string | null;
  /**
   * The message that these messages are in response to. They will be
   * the same "order" as this message, at increasing stepOrder(s).
   */
  promptMessageId?: string;
  /**
   * The messages to save.
   */
  messages: ((ModelMessage & { id?: string | undefined }) | Message)[];
  /**
   * Metadata to save with the messages. Each element corresponds to the
   * message at the same index.
   */
  metadata?: Omit<MessageWithMetadata, "message">[];
  /**
   * If false, it will "commit" the messages immediately.
   * If true, it will mark them as pending until the final step has finished.
   * Defaults to false.
   */
  pending?: boolean;
  /**
   * If true, it will fail any pending steps.
   * Defaults to false.
   */
  failPendingSteps?: boolean;
  /**
   * The embeddings to save with the messages.
   */
  embeddings?: Omit<MessageEmbeddings, "dimension">;
};

/**
 * Explicitly save messages associated with the thread (& user if provided)
 */
export async function saveMessages(
  ctx: RunMutationCtx,
  component: AgentComponent,
  args: SaveMessagesArgs & {
    /**
     * The agent name to associate with the messages.
     */
    agentName?: string;
  },
) {
  let embeddings: MessageEmbeddings | undefined;
  if (args.embeddings) {
    const dimension = args.embeddings.vectors.find((v) => v !== null)?.length;
    if (dimension) {
      validateVectorDimension(dimension);
      embeddings = {
        model: args.embeddings.model,
        dimension,
        vectors: args.embeddings.vectors,
      };
    }
  }
  const result = await ctx.runMutation(component.messages.addMessages, {
    threadId: args.threadId,
    userId: args.userId ?? undefined,
    agentName: args.agentName,
    promptMessageId: args.promptMessageId,
    embeddings,
    messages: await Promise.all(
      args.messages.map(async (m, i) => {
        const { message, fileIds } = await serializeMessage(ctx, component, m);
        return {
          ...args.metadata?.[i],
          message,
          fileIds,
        } as MessageWithMetadata;
      }),
    ),
    failPendingSteps: args.failPendingSteps ?? false,
    pending: args.pending ?? false,
  });
  return {
    lastMessageId: result.messages.at(-1)!._id,
    messages: result.messages,
  };
}

export type SaveMessageArgs = {
  threadId: string;
  userId?: string | null;
  /**
   * Metadata to save with the messages. Each element corresponds to the
   * message at the same index.
   */
  metadata?: Omit<MessageWithMetadata, "message">;
  /**
   * The embedding to save with the message.
   */
  embedding?: { vector: number[]; model: string };
} & (
  | {
      prompt?: undefined;
      /**
       * The message to save.
       */
      message: ModelMessage | Message;
    }
  | {
      /*
       * The prompt to save with the message.
       */
      prompt: string;
      message?: undefined;
    }
);

/**
 * Save a message to the thread.
 * @param ctx A ctx object from a mutation or action.
 * @param args The message and what to associate it with (user / thread)
 * You can pass extra metadata alongside the message, e.g. associated fileIds.
 * @returns The messageId of the saved message.
 */
export async function saveMessage(
  ctx: RunMutationCtx,
  component: AgentComponent,
  args: SaveMessageArgs & {
    /**
     * The agent name to associate with the message.
     */
    agentName?: string;
  },
) {
  let embeddings: { vectors: number[][]; model: string } | undefined;
  if (args.embedding && args.embedding.vector) {
    embeddings = {
      model: args.embedding.model,
      vectors: [args.embedding.vector],
    };
  }
  const { lastMessageId, messages } = await saveMessages(ctx, component, {
    threadId: args.threadId,
    userId: args.userId ?? undefined,
    agentName: args.agentName,
    messages:
      args.prompt !== undefined
        ? [{ role: "user", content: args.prompt }]
        : [args.message],
    metadata: args.metadata ? [args.metadata] : undefined,
    embeddings,
  });
  return { messageId: lastMessageId, message: messages.at(-1)! };
}
