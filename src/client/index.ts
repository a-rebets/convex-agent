import type {
  FlexibleSchema,
  IdGenerator,
  InferSchema,
} from "@ai-sdk/provider-utils";
import type {
  CallSettings,
  EmbeddingModel,
  GenerateObjectResult,
  GenerateTextResult,
  LanguageModel,
  ModelMessage,
  StepResult,
  StopCondition,
  StreamTextResult,
  ToolChoice,
  ToolSet,
} from "ai";
import {
  embedMany,
  generateObject,
  generateText,
  stepCountIs,
  streamObject,
  streamText,
} from "ai";
import { assert, omit, pick } from "convex-helpers";
import {
  internalActionGeneric,
  internalMutationGeneric,
  type GenericDataModel,
  type PaginationOptions,
  type PaginationResult,
  type WithoutSystemFields,
} from "convex/server";
import { convexToJson, v, type Value } from "convex/values";
import type { MessageDoc, ThreadDoc } from "../component/schema.js";
import type { threadFieldsSupportingPatch } from "../component/threads.js";
import {
  validateVectorDimension,
  type VectorDimension,
} from "../component/vector/tables.js";
import {
  deserializeMessage,
  serializeMessage,
  serializeNewMessagesInStep,
  serializeObjectResult,
} from "../mapping.js";
import { extractText, isTool } from "../shared.js";
import {
  vMessageEmbeddings,
  vMessageWithMetadata,
  vSafeObjectArgs,
  vTextArgs,
  type Message,
  type MessageStatus,
  type MessageWithMetadata,
  type ProviderMetadata,
  type StreamArgs,
  type Usage,
} from "../validators.js";
import { createTool, wrapTools, type ToolCtx } from "./createTool.js";
import {
  listMessages,
  saveMessages,
  type SaveMessageArgs,
  type SaveMessagesArgs,
} from "./messages.js";
import {
  fetchContextMessages,
  getModelName,
  getProviderName,
} from "./search.js";
import {
  DeltaStreamer,
  mergeTransforms,
  syncStreams,
  type StreamingOptions,
} from "./streaming.js";
import { createThread, getThreadMetadata } from "./threads.js";
import type {
  ActionCtx,
  AgentComponent,
  ContextOptions,
  DefaultObjectSchema,
  GenerationOutputMetadata,
  MaybeCustomCtx,
  GenerateObjectArgs,
  ObjectMode,
  ObjectSchema,
  Options,
  RawRequestResponseHandler,
  RunActionCtx,
  RunMutationCtx,
  RunQueryCtx,
  StorageOptions,
  StreamingTextArgs,
  StreamObjectArgs,
  SyncStreamsReturnValue,
  TextArgs,
  Thread,
  UsageHandler,
  UserActionCtx,
} from "./types.js";
import { inlineMessagesFiles } from "./files.js";
import type { DataModel } from "../component/_generated/dataModel.js";

export { stepCountIs } from "ai";
export { vMessageDoc, vThreadDoc } from "../component/schema.js";
export {
  deserializeMessage,
  serializeDataOrUrl,
  serializeMessage,
} from "../mapping.js";
// NOTE: these are also exported via @convex-dev/agent/validators
// a future version may put them all here or move these over there
export {
  vAssistantMessage,
  vContextOptions,
  vMessage,
  vPaginationResult,
  vProviderMetadata,
  vStorageOptions,
  vStreamArgs,
  vSystemMessage,
  vToolMessage,
  vUsage,
  vUserMessage,
} from "../validators.js";
export type { ToolCtx } from "./createTool.js";
export {
  definePlaygroundAPI,
  type AgentsFn,
  type PlaygroundAPI,
} from "./definePlaygroundAPI.js";
export { getFile, storeFile } from "./files.js";
export {
  listMessages,
  saveMessage,
  saveMessages,
  type SaveMessageArgs,
  type SaveMessagesArgs,
} from "./messages.js";
export {
  fetchContextMessages,
  filterOutOrphanedToolMessages,
} from "./search.js";
export { abortStream, listStreams, syncStreams } from "./streaming.js";
export { createThread, getThreadMetadata } from "./threads.js";
export { createTool, extractText, isTool };
export type {
  AgentComponent,
  ContextOptions,
  MessageDoc,
  ProviderMetadata,
  RawRequestResponseHandler,
  StorageOptions,
  StreamArgs,
  SyncStreamsReturnValue,
  Thread,
  ThreadDoc,
  Usage,
  UsageHandler,
};

export type Config = {
  /**
   * The LLM model to use for generating / streaming text and objects.
   * e.g.
   * import { openai } from "@ai-sdk/openai"
   * const myAgent = new Agent(components.agent, {
   *   languageModel: openai.chat("gpt-4o-mini"),
   */
  languageModel?: LanguageModel;
  /**
   * The model to use for text embeddings. Optional.
   * If specified, it will use this for generating vector embeddings
   * of chats, and can opt-in to doing vector search for automatic context
   * on generateText, etc.
   * e.g.
   * import { openai } from "@ai-sdk/openai"
   * const myAgent = new Agent(components.agent, {
   *   ...
   *   textEmbeddingModel: openai.embedding("text-embedding-3-small")
   */
  textEmbeddingModel?: EmbeddingModel<string>;
  /**
   * Options to determine what messages are included as context in message
   * generation. To disable any messages automatically being added, pass:
   * { recentMessages: 0 }
   */
  contextOptions?: ContextOptions;
  /**
   * Determines whether messages are automatically stored when passed as
   * arguments or generated.
   */
  storageOptions?: StorageOptions;
  /**
   * The default settings to use for the LLM calls.
   * This can be overridden at each generate/stream callsite on a per-field
   * basis. To clear a default setting, you'll need to pass `undefined`.
   */
  callSettings?: CallSettings;
  /**
   * The usage handler to use for this agent.
   */
  usageHandler?: UsageHandler;
  /**
   * Called for each LLM request/response, so you can do things like
   * log the raw request body or response headers to a table, or logs.
   */
  rawRequestResponseHandler?: RawRequestResponseHandler;
};

export class Agent<
  /**
   * You can require that all `ctx` args to generateText & streamText
   * have a certain shape by passing a type here.
   * e.g.
   * ```ts
   * const myAgent = new Agent<{ orgId: string }>(...);
   * ```
   * This is useful if you want to share that type in `createTool`
   * e.g.
   * ```ts
   * type MyCtx = ToolCtx & { orgId: string };
   * const myTool = createTool({
   *   args: z.object({...}),
   *   description: "...",
   *   handler: async (ctx: MyCtx, args) => {
   *     // use ctx.orgId
   *   },
   * });
   */
  CustomCtx extends object = object,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  AgentTools extends ToolSet = any,
> {
  constructor(
    public component: AgentComponent,
    public options: Config & {
      /**
       * The name for the agent. This will be attributed on each message
       * created by this agent.
       */
      name?: string;
      /**
       * The LLM model to use for generating / streaming text and objects.
       * e.g.
       * import { openai } from "@ai-sdk/openai"
       * const myAgent = new Agent(components.agent, {
       *   languageModel: openai.chat("gpt-4o-mini"),
       */
      languageModel: LanguageModel;
      /**
       * The default system prompt to put in each request.
       * Override per-prompt by passing the "system" parameter.
       */
      instructions?: string;
      /**
       * Tools that the agent can call out to and get responses from.
       * They can be AI SDK tools (import {tool} from "ai")
       * or tools that have Convex context
       * (import { createTool } from "@convex-dev/agent")
       */
      tools?: AgentTools;
      /**
       * When generating or streaming text with tools available, this
       * determines when to stop. Defaults to stepCountIs(1).
       */
      stopWhen?: StopCondition<AgentTools> | Array<StopCondition<AgentTools>>;
      /**
       * @deprecated Use `languageEmbeddingModel` instead.
       */
      chat?: LanguageModel;
    },
  ) {}

  /**
   * Start a new thread with the agent. This will have a fresh history, though if
   * you pass in a userId you can have it search across other threads for relevant
   * messages as context for the LLM calls.
   * @param ctx The context of the Convex function. From an action, you can thread
   *   with the agent. From a mutation, you can start a thread and save the threadId
   *   to pass to continueThread later.
   * @param args The thread metadata.
   * @returns The threadId of the new thread and the thread object.
   */
  async createThread(
    ctx: RunActionCtx & CustomCtx,
    args?: {
      /**
       * The userId to associate with the thread. If not provided, the thread will be
       * anonymous.
       */
      userId?: string | null;
      /**
       * The title of the thread. Not currently used for anything.
       */
      title?: string;
      /**
       * The summary of the thread. Not currently used for anything.
       */
      summary?: string;
    },
  ): Promise<{ threadId: string; thread: Thread<AgentTools> }>;
  /**
   * Start a new thread with the agent. This will have a fresh history, though if
   * you pass in a userId you can have it search across other threads for relevant
   * messages as context for the LLM calls.
   * @param ctx The context of the Convex function. From a mutation, you can
   * start a thread and save the threadId to pass to continueThread later.
   * @param args The thread metadata.
   * @returns The threadId of the new thread.
   */
  async createThread(
    ctx: RunMutationCtx,
    args?: {
      /**
       * The userId to associate with the thread. If not provided, the thread will be
       * anonymous.
       */
      userId?: string | null;
      /**
       * The title of the thread. Not currently used for anything.
       */
      title?: string;
      /**
       * The summary of the thread. Not currently used for anything.
       */
      summary?: string;
    },
  ): Promise<{ threadId: string }>;
  async createThread(
    ctx: (ActionCtx & CustomCtx) | RunMutationCtx,
    args?: { userId: string | null; title?: string; summary?: string },
  ): Promise<{ threadId: string; thread?: Thread<AgentTools> }> {
    const threadId = await createThread(ctx, this.component, args);
    if (!("runAction" in ctx) || "workflowId" in ctx) {
      return { threadId };
    }
    const { thread } = await this.continueThread(ctx, {
      threadId,
      userId: args?.userId,
    });
    return { threadId, thread };
  }

  /**
   * Continues a thread using this agent. Note: threads can be continued
   * by different agents. This is a convenience around calling the various
   * generate and stream functions with explicit userId and threadId parameters.
   * @param ctx The ctx object passed to the action handler
   * @param { threadId, userId }: the thread and user to associate the messages with.
   * @returns Functions bound to the userId and threadId on a `{thread}` object.
   */
  async continueThread(
    ctx: ActionCtx & CustomCtx,
    args: {
      /**
       * The associated thread created by {@link createThread}
       */
      threadId: string;
      /**
       * If supplied, the userId can be used to search across other threads for
       * relevant messages from the same user as context for the LLM calls.
       */
      userId?: string | null;
    },
  ): Promise<{ thread: Thread<AgentTools> }> {
    return {
      thread: {
        threadId: args.threadId,
        getMetadata: this.getThreadMetadata.bind(this, ctx, {
          threadId: args.threadId,
        }),
        updateMetadata: (patch: Partial<WithoutSystemFields<ThreadDoc>>) =>
          ctx.runMutation(this.component.threads.updateThread, {
            threadId: args.threadId,
            patch,
          }),
        generateText: this.generateText.bind(this, ctx, args),
        streamText: this.streamText.bind(this, ctx, args),
        generateObject: this.generateObject.bind(this, ctx, args),
        streamObject: this.streamObject.bind(this, ctx, args),
      } as Thread<AgentTools>,
    };
  }

  async start<TOOLS extends ToolSet | undefined, T>(
    ctx: ActionCtx & CustomCtx,
    /**
     * These are the arguments you'll pass to the LLM call such as
     * `generateText` or `streamText`. This function will look up the context
     * and provide functions to save the steps, abort the generation, and more.
     * The type of the arguments returned infers from the type of the arguments
     * you pass here.
     */
    args: T & {
      /**
       * If provided, this message will be used as the "prompt" for the LLM call,
       * instead of the prompt or messages.
       * This is useful if you want to first save a user message, then use it as
       * the prompt for the LLM call in another call.
       */
      promptMessageId?: string;
      /**
       * The model to use for the LLM calls. This will override the model specified
       * in the Agent constructor.
       */
      model?: LanguageModel;
      /**
       * The tools to use for the tool calls. This will override tools specified
       * in the Agent constructor or createThread / continueThread.
       */
      tools?: TOOLS;
      /**
       * The single prompt message to use for the LLM call. This will be the
       * last message in the context. If it's a string, it will be a user role.
       */
      prompt?: string | (ModelMessage | Message)[];
      /**
       * If provided alongside prompt, the ordering will be:
       * 1. system prompt
       * 2. search context
       * 3. recent messages
       * 4. these messages
       * 5. prompt messages, including those already on the same `order` as
       *   the promptMessageId message, if provided.
       */
      messages?: (ModelMessage | Message)[];
      /**
       * This will be the first message in the context, and overrides the
       * agent's instructions.
       */
      system?: string;
      /**
       * The abort signal to be passed to the LLM call. If triggered, it will
       * mark the pending message as failed. If the generation is asynchronously
       * aborted, it will trigger this signal when detected.
       */
      abortSignal?: AbortSignal;
      // We optimistically override the generateId function to use the pending
      // message id.
      _internal?: { generateId?: IdGenerator };
    },
    options?: Options & { userId?: string | null; threadId?: string },
  ): Promise<{
    args: T & {
      system?: string;
      model: LanguageModel;
      messages: ModelMessage[];
      // abortSignal?: AbortSignal;
      tools?: TOOLS extends undefined ? AgentTools : TOOLS;
    } & CallSettings;
    order: number;
    stepOrder: number;
    userId: string | undefined;
    promptMessageId: string | undefined;
    updateModel: (model: LanguageModel | undefined) => void;
    save: <TOOLS extends ToolSet>(
      toSave:
        | { step: StepResult<TOOLS> }
        | { object: GenerateObjectResult<unknown> },
      createPendingMessage?: boolean,
    ) => Promise<void>;
    fail: (reason: string) => Promise<void>;
    getSavedMessages: () => MessageDoc[];
  }> {
    const { threadId, ...opts } = { ...this.options, ...options };
    const context = await this._saveMessagesAndFetchContext(ctx, args, {
      userId: options?.userId,
      threadId: options?.threadId,
      ...opts,
    });
    let pendingMessageId = context.pendingMessageId;
    // TODO: extract pending message if one exists
    const { args: aiArgs, promptMessageId, order, stepOrder, userId } = context;
    const messages = context.savedMessages ?? [];
    if (pendingMessageId) {
      if (!aiArgs._internal?.generateId) {
        aiArgs._internal = {
          ...aiArgs._internal,
          generateId: () => pendingMessageId ?? crypto.randomUUID(),
        };
      }
    }
    const toolCtx = {
      ...(ctx as UserActionCtx & CustomCtx),
      userId,
      threadId,
      promptMessageId,
      agent: this,
    } satisfies ToolCtx;
    type Tools = TOOLS extends undefined ? AgentTools : TOOLS;
    const tools = wrapTools(toolCtx, args.tools ?? this.options.tools) as Tools;
    const saveOutput = opts.storageOptions?.saveMessages !== "none";
    const fail = async (reason: string) => {
      if (threadId && promptMessageId) {
        console.error("RollbackMessage", promptMessageId, reason);
      }
      if (pendingMessageId) {
        await ctx.runMutation(this.component.messages.finalizeMessage, {
          messageId: pendingMessageId,
          result: { status: "failed", error: reason },
        });
      }
    };
    let activeModel = aiArgs.model;
    if (aiArgs.abortSignal) {
      const abortSignal = aiArgs.abortSignal;
      aiArgs.abortSignal.addEventListener(
        "abort",
        async () => {
          await fail(abortSignal.reason ?? "Aborted");
        },
        { once: true },
      );
    }
    return {
      args: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        stopWhen: (args as any).stopWhen ?? this.options.stopWhen,
        ...aiArgs,
        tools,
        // abortSignal: abortController.signal,
      },
      order: order ?? 0,
      stepOrder: stepOrder ?? 0,
      userId,
      promptMessageId,
      getSavedMessages: () => messages,
      updateModel: (model: LanguageModel | undefined) => {
        if (model) {
          activeModel = model;
        }
      },
      fail,
      save: async <TOOLS extends ToolSet>(
        toSave:
          | { step: StepResult<TOOLS> }
          | { object: GenerateObjectResult<unknown> },
        createPendingMessage?: boolean,
      ) => {
        if (threadId && promptMessageId && saveOutput) {
          const metadata = {
            // TODO: get up to date one when user selects mid-generation
            model: getModelName(activeModel),
            provider: getProviderName(activeModel),
          };
          const serialized =
            "object" in toSave
              ? await serializeObjectResult(
                  ctx,
                  this.component,
                  toSave.object,
                  metadata,
                )
              : await serializeNewMessagesInStep(
                  ctx,
                  this.component,
                  toSave.step,
                  metadata,
                );
          const embeddings = await this.generateEmbeddings(
            ctx,
            { userId, threadId },
            serialized.messages.map((m) => m.message),
          );
          if (createPendingMessage) {
            serialized.messages.push({
              message: { role: "assistant", content: [] },
              status: "pending",
            });
            embeddings?.vectors.push(null);
          }
          const saved = await ctx.runMutation(
            this.component.messages.addMessages,
            {
              userId,
              threadId,
              agentName: this.options.name,
              promptMessageId,
              pendingMessageId,
              messages: serialized.messages,
              embeddings,
              failPendingSteps: false,
            },
          );
          const lastMessage = saved.messages.at(-1)!;
          if (createPendingMessage) {
            if (lastMessage.status === "failed") {
              pendingMessageId = undefined;
              messages.push(...saved.messages);
              await fail(
                lastMessage.error ??
                  "Aborting - the pending message was marked as failed",
              );
            } else {
              pendingMessageId = lastMessage._id;
              messages.push(...saved.messages.slice(0, -1));
            }
          } else {
            pendingMessageId = undefined;
            messages.push(...saved.messages);
          }
        }
        const output = "object" in toSave ? toSave.object : toSave.step;
        if (this.options.rawRequestResponseHandler) {
          await this.options.rawRequestResponseHandler(ctx, {
            userId,
            threadId,
            agentName: this.options.name,
            request: output.request,
            response: output.response,
          });
        }
        if (opts.usageHandler && output.usage) {
          await opts.usageHandler(ctx, {
            userId,
            threadId,
            agentName: this.options.name,
            model: getModelName(activeModel),
            provider: getProviderName(activeModel),
            usage: output.usage,
            providerMetadata: output.providerMetadata,
          });
        }
      },
    };
  }

  /**
   * This behaves like {@link generateText} from the "ai" package except that
   * it add context based on the userId and threadId and saves the input and
   * resulting messages to the thread, if specified.
   * Use {@link continueThread} to get a version of this function already scoped
   * to a thread (and optionally userId).
   * @param ctx The context passed from the action function calling this.
   * @param { userId, threadId }: The user and thread to associate the message with
   * @param generateTextArgs The arguments to the generateText function, along with extra controls
   * for the {@link ContextOptions} and {@link StorageOptions}.
   * @returns The result of the generateText function.
   */
  async generateText<
    TOOLS extends ToolSet | undefined = undefined,
    OUTPUT = never,
    OUTPUT_PARTIAL = never,
  >(
    ctx: ActionCtx & CustomCtx,
    threadOpts: { userId?: string | null; threadId?: string },
    generateTextArgs: TextArgs<AgentTools, TOOLS, OUTPUT, OUTPUT_PARTIAL>,
    options?: Options,
  ): Promise<
    GenerateTextResult<TOOLS extends undefined ? AgentTools : TOOLS, OUTPUT> &
      GenerationOutputMetadata
  > {
    const { args, promptMessageId, order, ...call } = await this.start(
      ctx,
      generateTextArgs,
      { ...threadOpts, ...options },
    );

    type Tools = TOOLS extends undefined ? AgentTools : TOOLS;
    const steps: StepResult<Tools>[] = [];
    try {
      const result = (await generateText<Tools, OUTPUT, OUTPUT_PARTIAL>({
        ...args,
        prepareStep: async (options) => {
          const result = await generateTextArgs.prepareStep?.(options);
          call.updateModel(result?.model ?? options.model);
          return result;
        },
        onStepFinish: async (step) => {
          steps.push(step);
          await call.save({ step }, await willContinue(steps, args.stopWhen));
          return generateTextArgs.onStepFinish?.(step);
        },
      })) as GenerateTextResult<Tools, OUTPUT>;
      const metadata: GenerationOutputMetadata = {
        promptMessageId,
        order,
        savedMessages: call.getSavedMessages(),
        messageId: promptMessageId,
      };
      return Object.assign(result, metadata);
    } catch (error) {
      await call.fail(errorToString(error));
      throw error;
    }
  }

  /**
   * This behaves like {@link streamText} from the "ai" package except that
   * it add context based on the userId and threadId and saves the input and
   * resulting messages to the thread, if specified.
   * Use {@link continueThread} to get a version of this function already scoped
   * to a thread (and optionally userId).
   */
  async streamText<
    TOOLS extends ToolSet | undefined = undefined,
    OUTPUT = never,
    PARTIAL_OUTPUT = never,
  >(
    ctx: ActionCtx & CustomCtx,
    threadOpts: { userId?: string | null; threadId?: string },
    /**
     * The arguments to the streamText function, similar to the ai `streamText` function.
     */
    streamTextArgs: StreamingTextArgs<
      AgentTools,
      TOOLS,
      OUTPUT,
      PARTIAL_OUTPUT
    >,
    /**
     * The {@link ContextOptions} and {@link StorageOptions}
     * options to use for fetching contextual messages and saving input/output messages.
     */
    options?: Options & {
      /**
       * Whether to save incremental data (deltas) from streaming responses.
       * Defaults to false.
       * If false, it will not save any deltas to the database.
       * If true, it will save deltas with {@link DEFAULT_STREAMING_OPTIONS}.
       *
       * Regardless of this option, when streaming you are able to use this
       * `streamText` function as you would with the "ai" package's version:
       * iterating over the text, streaming it over HTTP, etc.
       */
      saveStreamDeltas?: boolean | StreamingOptions;
    },
  ): Promise<
    StreamTextResult<
      TOOLS extends undefined ? AgentTools : TOOLS,
      PARTIAL_OUTPUT
    > &
      GenerationOutputMetadata
  > {
    const { threadId } = threadOpts;
    const { args, userId, order, stepOrder, promptMessageId, ...call } =
      await this.start(ctx, streamTextArgs, { ...threadOpts, ...options });

    type Tools = TOOLS extends undefined ? AgentTools : TOOLS;
    const steps: StepResult<Tools>[] = [];

    const opts = { ...this.options, ...options };
    const streamer =
      threadId && opts.saveStreamDeltas
        ? new DeltaStreamer(this.component, ctx, opts.saveStreamDeltas, {
            threadId,
            userId,
            agentName: this.options.name,
            model: getModelName(args.model),
            provider: getProviderName(args.model),
            providerOptions: args.providerOptions,
            order,
            stepOrder,
            abortSignal: args.abortSignal,
          })
        : undefined;

    const result = streamText({
      ...args,
      abortSignal: streamer?.abortController.signal ?? args.abortSignal,
      // TODO: this is probably why reasoning isn't streaming
      experimental_transform: mergeTransforms(
        options?.saveStreamDeltas,
        streamTextArgs.experimental_transform,
      ),
      onChunk: async (event) => {
        await streamer?.addParts([event.chunk]);
        // console.log("onChunk", chunk);
        return streamTextArgs.onChunk?.(event);
      },
      onError: async (error) => {
        console.error("onError", error);
        await call.fail(errorToString(error.error));
        await streamer?.fail(errorToString(error.error));
        return streamTextArgs.onError?.(error);
      },
      // onFinish: async (event) => {
      //   return streamTextArgs.onFinish?.(event);
      // },
      prepareStep: async (options) => {
        const result = await streamTextArgs.prepareStep?.(options);
        if (result) {
          const model = result.model ?? options.model;
          call.updateModel(model);
          return result;
        }
        return undefined;
      },
      onStepFinish: async (step) => {
        steps.push(step);
        const createPendingMessage = await willContinue(steps, args.stopWhen);
        await call.save({ step }, createPendingMessage);
        if (!createPendingMessage) {
          await streamer?.finish();
        }
        return args.onStepFinish?.(step);
      },
    }) as StreamTextResult<
      TOOLS extends undefined ? AgentTools : TOOLS,
      PARTIAL_OUTPUT
    >;
    const metadata: GenerationOutputMetadata = {
      promptMessageId,
      order,
      savedMessages: call.getSavedMessages(),
      messageId: promptMessageId,
    };
    return Object.assign(result, metadata);
  }

  /**
   * This behaves like {@link generateObject} from the "ai" package except that
   * it add context based on the userId and threadId and saves the input and
   * resulting messages to the thread, if specified.
   * Use {@link continueThread} to get a version of this function already scoped
   * to a thread (and optionally userId).
   */
  async generateObject<
    SCHEMA extends ObjectSchema = DefaultObjectSchema,
    OUTPUT extends ObjectMode = InferSchema<SCHEMA> extends string
      ? "enum"
      : "object",
    RESULT = OUTPUT extends "array"
      ? Array<InferSchema<SCHEMA>>
      : InferSchema<SCHEMA>,
  >(
    ctx: ActionCtx & CustomCtx,
    threadOpts: { userId?: string | null; threadId?: string },
    /**
     * The arguments to the generateObject function, similar to the ai.generateObject function.
     */
    generateObjectArgs: GenerateObjectArgs<SCHEMA, OUTPUT, RESULT>,
    /**
     * The {@link ContextOptions} and {@link StorageOptions}
     * options to use for fetching contextual messages and saving input/output messages.
     */
    options?: Options,
  ): Promise<GenerateObjectResult<RESULT> & GenerationOutputMetadata> {
    const { args, promptMessageId, order, fail, save, getSavedMessages } =
      await this.start(ctx, generateObjectArgs, { ...threadOpts, ...options });

    try {
      const result = (await generateObject(
        args,
      )) as GenerateObjectResult<RESULT>;

      await save({ object: result });
      const metadata: GenerationOutputMetadata = {
        promptMessageId,
        order,
        savedMessages: getSavedMessages(),
        messageId: promptMessageId,
      };
      return Object.assign(result, metadata);
    } catch (error) {
      await fail(errorToString(error));
      throw error;
    }
  }

  /**
   * This behaves like `streamObject` from the "ai" package except that
   * it add context based on the userId and threadId and saves the input and
   * resulting messages to the thread, if specified.
   * Use {@link continueThread} to get a version of this function already scoped
   * to a thread (and optionally userId).
   */
  async streamObject<
    SCHEMA extends ObjectSchema = DefaultObjectSchema,
    OUTPUT extends ObjectMode = InferSchema<SCHEMA> extends string
      ? "enum"
      : "object",
    RESULT = OUTPUT extends "array"
      ? Array<InferSchema<SCHEMA>>
      : InferSchema<SCHEMA>,
  >(
    ctx: ActionCtx & CustomCtx,
    threadOpts: { userId?: string | null; threadId?: string },
    /**
     * The arguments to the streamObject function, similar to the ai `streamObject` function.
     */
    streamObjectArgs: StreamObjectArgs<SCHEMA, OUTPUT, RESULT> & {
      /**
       * If provided, this message will be used as the "prompt" for the LLM call,
       * instead of the prompt or messages.
       * This is useful if you want to first save a user message, then use it as
       * the prompt for the LLM call in another call.
       */
      promptMessageId?: string;
      /**
       * The model to use for the LLM calls. This will override the model specified
       * in the Agent constructor.
       */
      model?: LanguageModel;
      /**
       * The tools to use for the tool calls. This will override tools specified
       * in the Agent constructor or createThread / continueThread.
       */
    },
    /**
     * The {@link ContextOptions} and {@link StorageOptions}
     * options to use for fetching contextual messages and saving input/output messages.
     */
    options?: Options,
  ): Promise<
    ReturnType<typeof streamObject<SCHEMA, OUTPUT, RESULT>> &
      GenerationOutputMetadata
  > {
    const { args, promptMessageId, order, fail, save, getSavedMessages } =
      await this.start(ctx, streamObjectArgs, { ...threadOpts, ...options });

    const stream = streamObject<SCHEMA, OUTPUT, RESULT>({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(args as any),
      onError: async (error) => {
        console.error(" streamObject onError", error);
        // TODO: content that we have so far
        // content: stream.fullStream.
        await fail(errorToString(error.error));
        return args.onError?.(error);
      },
      onFinish: async (result) => {
        await save({
          object: {
            object: result.object,
            finishReason: result.error ? "error" : "stop",
            usage: result.usage,
            warnings: result.warnings,
            request: await stream.request,
            response: result.response,
            providerMetadata: result.providerMetadata,
            toJsonResponse: stream.toTextStreamResponse,
          },
        });
        return args.onFinish?.(result);
      },
    });
    const metadata: GenerationOutputMetadata = {
      promptMessageId,
      order,
      savedMessages: getSavedMessages(),
      messageId: promptMessageId,
    };
    return Object.assign(stream, metadata);
  }

  /**
   * Save a message to the thread.
   * @param ctx A ctx object from a mutation or action.
   * @param args The message and what to associate it with (user / thread)
   * You can pass extra metadata alongside the message, e.g. associated fileIds.
   * @returns The messageId of the saved message.
   */
  async saveMessage(
    ctx: RunMutationCtx,
    args: SaveMessageArgs & {
      /**
       * If true, it will not generate embeddings for the message.
       * Useful if you're saving messages in a mutation where you can't run `fetch`.
       * You can generate them asynchronously by using the scheduler to run an
       * action later that calls `agent.generateAndSaveEmbeddings`.
       */
      skipEmbeddings?: boolean;
    },
  ) {
    const { messages } = await this.saveMessages(ctx, {
      threadId: args.threadId,
      userId: args.userId,
      embeddings: args.embedding
        ? { model: args.embedding.model, vectors: [args.embedding.vector] }
        : undefined,
      messages:
        args.prompt !== undefined
          ? [{ role: "user", content: args.prompt }]
          : [args.message],
      metadata: args.metadata ? [args.metadata] : undefined,
      skipEmbeddings: args.skipEmbeddings,
      pendingMessageId: args.pendingMessageId,
    });
    const message = messages.at(-1)!;
    return { messageId: message._id, message };
  }

  /**
   * Explicitly save messages associated with the thread (& user if provided)
   * If you have an embedding model set, it will also generate embeddings for
   * the messages.
   * @param ctx The ctx parameter to a mutation or action.
   * @param args The messages and context to save
   * @returns
   */
  async saveMessages(
    ctx: RunMutationCtx | RunActionCtx,
    args: SaveMessagesArgs & {
      /**
       * Skip generating embeddings for the messages. Useful if you're
       * saving messages in a mutation where you can't run `fetch`.
       * You can generate them asynchronously by using the scheduler to run an
       * action later that calls `agent.generateAndSaveEmbeddings`.
       */
      skipEmbeddings?: boolean;
    },
  ): Promise<{ messages: MessageDoc[] }> {
    let embeddings: { vectors: (number[] | null)[]; model: string } | undefined;
    const { skipEmbeddings, ...rest } = args;
    if (args.embeddings) {
      embeddings = args.embeddings;
    } else if (!skipEmbeddings && this.options.textEmbeddingModel) {
      if (!("runAction" in ctx)) {
        console.warn(
          "You're trying to save messages and generate embeddings, but you're in a mutation. " +
            "Pass `skipEmbeddings: true` to skip generating embeddings in the mutation and skip this warning. " +
            "They will be generated lazily when you generate or stream text / objects. " +
            "You can explicitly generate them asynchronously by using the scheduler to run an action later that calls `agent.generateAndSaveEmbeddings`.",
        );
      } else if ("workflowId" in ctx) {
        console.warn(
          "You're trying to save messages and generate embeddings, but you're in a workflow. " +
            "Pass `skipEmbeddings: true` to skip generating embeddings in the workflow and skip this warning. " +
            "They will be generated lazily when you generate or stream text / objects. " +
            "You can explicitly generate them asynchronously by using the scheduler to run an action later that calls `agent.generateAndSaveEmbeddings`.",
        );
      } else {
        embeddings = await this.generateEmbeddings(
          ctx,
          { userId: args.userId ?? undefined, threadId: args.threadId },
          args.messages,
        );
      }
    }
    return saveMessages(ctx, this.component, {
      ...rest,
      agentName: this.options.name,
      embeddings,
    });
  }

  /**
   * List messages from a thread.
   * @param ctx A ctx object from a query, mutation, or action.
   * @param args.threadId The thread to list messages from.
   * @param args.paginationOpts Pagination options (e.g. via usePaginatedQuery).
   * @param args.excludeToolMessages Whether to exclude tool messages.
   *   False by default.
   * @param args.statuses What statuses to include. All by default.
   * @returns The MessageDoc's in a format compatible with usePaginatedQuery.
   */
  async listMessages(
    ctx: RunQueryCtx,
    args: {
      threadId: string;
      paginationOpts: PaginationOptions;
      excludeToolMessages?: boolean;
      statuses?: MessageStatus[];
    },
  ): Promise<PaginationResult<MessageDoc>> {
    return listMessages(ctx, this.component, args);
  }

  /**
   * A function that handles fetching stream deltas, used with the React hooks
   * `useThreadMessages` or `useStreamingThreadMessages`.
   * @param ctx A ctx object from a query, mutation, or action.
   * @param args.threadId The thread to sync streams for.
   * @param args.streamArgs The stream arguments with per-stream cursors.
   * @returns The deltas for each stream from their existing cursor.
   */
  async syncStreams(
    ctx: RunQueryCtx,
    args: {
      threadId: string;
      streamArgs: StreamArgs | undefined;
      // By default, only streaming messages are included.
      includeStatuses?: ("streaming" | "finished" | "aborted")[];
    },
  ): Promise<SyncStreamsReturnValue | undefined> {
    return syncStreams(ctx, this.component, args);
  }

  /**
   * Fetch the context messages for a thread.
   * @param ctx Either a query, mutation, or action ctx.
   *   If it is not an action context, you can't do text or
   *   vector search.
   * @param args The associated thread, user, message
   * @returns
   */
  async fetchContextMessages(
    ctx: RunQueryCtx | RunActionCtx,
    args: {
      userId: string | undefined;
      threadId: string | undefined;
      messages: (ModelMessage | Message)[];
      /**
       * If provided, it will search for messages up to and including this message.
       * Note: if this is far in the past, text and vector search results may be more
       * limited, as it's post-filtering the results.
       */
      upToAndIncludingMessageId?: string;
      contextOptions: ContextOptions | undefined;
    },
  ): Promise<MessageDoc[]> {
    assert(args.userId || args.threadId, "Specify userId or threadId");
    const contextOptions = {
      ...this.options.contextOptions,
      ...args.contextOptions,
    };
    return fetchContextMessages(ctx, this.component, {
      ...args,
      contextOptions,
      getEmbedding: async (text) => {
        assert("runAction" in ctx);
        assert(
          this.options.textEmbeddingModel,
          "A textEmbeddingModel is required to be set on the Agent that you're doing vector search with",
        );
        return {
          embedding: (
            await this.doEmbed(ctx, {
              userId: args.userId,
              threadId: args.threadId,
              values: [text],
            })
          ).embeddings[0],
          textEmbeddingModel: this.options.textEmbeddingModel,
        };
      },
    });
  }

  /**
   * Get the metadata for a thread.
   * @param ctx A ctx object from a query, mutation, or action.
   * @param args.threadId The thread to get the metadata for.
   * @returns The metadata for the thread.
   */
  async getThreadMetadata(
    ctx: RunQueryCtx,
    args: { threadId: string },
  ): Promise<ThreadDoc> {
    return getThreadMetadata(ctx, this.component, args);
  }

  /**
   * Update the metadata for a thread.
   * @param ctx A ctx object from a mutation or action.
   * @param args.threadId The thread to update the metadata for.
   * @param args.patch The patch to apply to the thread.
   * @returns The updated thread metadata.
   */
  async updateThreadMetadata(
    ctx: RunMutationCtx,
    args: {
      threadId: string;
      patch: Partial<
        Pick<ThreadDoc, (typeof threadFieldsSupportingPatch)[number]>
      >;
    },
  ): Promise<ThreadDoc> {
    const thread = await ctx.runMutation(
      this.component.threads.updateThread,
      args,
    );
    return thread;
  }

  /**
   * Get the embeddings for a set of messages.
   * @param messages The messages to get the embeddings for.
   * @returns The embeddings for the messages.
   */
  async generateEmbeddings(
    ctx: RunActionCtx,
    {
      userId,
      threadId,
    }: { userId: string | undefined; threadId: string | undefined },
    messages: (ModelMessage | Message)[],
  ) {
    if (!this.options.textEmbeddingModel) {
      return undefined;
    }
    let embeddings:
      | {
          vectors: (number[] | null)[];
          dimension: VectorDimension;
          model: string;
        }
      | undefined;
    const messageTexts = messages.map((m) => !isTool(m) && extractText(m));
    // Find the indexes of the messages that have text.
    const textIndexes = messageTexts
      .map((t, i) => (t ? i : undefined))
      .filter((i) => i !== undefined);
    if (textIndexes.length === 0) {
      return undefined;
    }
    const values = messageTexts.filter((t): t is string => !!t);
    // Then embed those messages.
    const textEmbeddings = await this.doEmbed(ctx, {
      userId,
      threadId,
      values,
    });
    // Then assemble the embeddings into a single array with nulls for the messages without text.
    const embeddingsOrNull = Array(messages.length).fill(null);
    textIndexes.forEach((i, j) => {
      embeddingsOrNull[i] = textEmbeddings.embeddings[j];
    });
    if (textEmbeddings.embeddings.length > 0) {
      const dimension = textEmbeddings.embeddings[0].length;
      validateVectorDimension(dimension);
      const model = getModelName(this.options.textEmbeddingModel);
      embeddings = { vectors: embeddingsOrNull, dimension, model };
    }
    return embeddings;
  }

  /**
   * Generate embeddings for a set of messages, and save them to the database.
   * It will not generate or save embeddings for messages that already have an
   * embedding.
   * @param ctx The ctx parameter to an action.
   * @param args The messageIds to generate embeddings for.
   */
  async generateAndSaveEmbeddings(
    ctx: RunActionCtx,
    args: { messageIds: string[] },
  ) {
    const messages = (
      await ctx.runQuery(this.component.messages.getMessagesByIds, {
        messageIds: args.messageIds,
      })
    ).filter((m): m is NonNullable<typeof m> => m !== null);
    if (messages.length !== args.messageIds.length) {
      throw new Error(
        "Some messages were not found: " +
          args.messageIds
            .filter((id) => !messages.some((m) => m?._id === id))
            .join(", "),
      );
    }
    await this._generateAndSaveEmbeddings(ctx, messages);
  }

  async _generateAndSaveEmbeddings(ctx: RunActionCtx, messages: MessageDoc[]) {
    if (messages.some((m) => !m.message)) {
      throw new Error(
        "Some messages don't have a message: " +
          messages
            .filter((m) => !m.message)
            .map((m) => m._id)
            .join(", "),
      );
    }
    const messagesMissingEmbeddings = messages.filter((m) => !m.embeddingId);
    if (messagesMissingEmbeddings.length === 0) {
      return;
    }
    const embeddings = await this.generateEmbeddings(
      ctx,
      {
        userId: messagesMissingEmbeddings[0]!.userId,
        threadId: messagesMissingEmbeddings[0]!.threadId,
      },
      messagesMissingEmbeddings.map((m) => deserializeMessage(m!.message!)),
    );
    if (!embeddings) {
      if (!this.options.textEmbeddingModel) {
        throw new Error(
          "No embeddings were generated for the messages. You must pass a textEmbeddingModel to the agent constructor.",
        );
      }
      throw new Error(
        "No embeddings were generated for these messages: " +
          messagesMissingEmbeddings.map((m) => m!._id).join(", "),
      );
    }
    await ctx.runMutation(this.component.vector.index.insertBatch, {
      vectorDimension: embeddings.dimension,
      vectors: messagesMissingEmbeddings
        .map((m, i) => ({
          messageId: m!._id,
          model: embeddings.model,
          table: "messages",
          userId: m.userId,
          threadId: m.threadId,
          vector: embeddings.vectors[i],
        }))
        .filter(
          (v): v is Extract<typeof v, { vector: number[] }> =>
            v.vector !== null,
        ),
    });
  }

  /**
   * Explicitly save a "step" created by the AI SDK.
   * @param ctx The ctx argument to a mutation or action.
   * @param args The Step generated by the AI SDK.
   */
  async saveStep<TOOLS extends ToolSet>(
    ctx: ActionCtx,
    args: {
      userId?: string;
      threadId: string;
      /**
       * The message this step is in response to.
       */
      promptMessageId: string;
      /**
       * The step to save, possibly including multiple tool calls.
       */
      step: StepResult<TOOLS>;
      /**
       * The model used to generate the step.
       * Defaults to the chat model for the Agent.
       */
      model?: string;
      /**
       * The provider of the model used to generate the step.
       * Defaults to the chat provider for the Agent.
       */
      provider?: string;
    },
  ): Promise<{ messages: MessageDoc[] }> {
    const { messages } = await serializeNewMessagesInStep(
      ctx,
      this.component,
      args.step,
      {
        provider: args.provider ?? getProviderName(this.options.languageModel),
        model: args.model ?? getModelName(this.options.languageModel),
      },
    );
    const embeddings = await this.generateEmbeddings(
      ctx,
      { userId: args.userId, threadId: args.threadId },
      messages.map((m) => m.message),
    );
    return ctx.runMutation(this.component.messages.addMessages, {
      userId: args.userId,
      threadId: args.threadId,
      agentName: this.options.name,
      promptMessageId: args.promptMessageId,
      messages,
      embeddings,
      failPendingSteps: false,
    });
  }

  /**
   * Manually save the result of a generateObject call to the thread.
   * This happens automatically when using {@link generateObject} or {@link streamObject}
   * from the `thread` object created by {@link continueThread} or {@link createThread}.
   * @param ctx The context passed from the mutation or action function calling this.
   * @param args The arguments to the saveObject function.
   */
  async saveObject(
    ctx: ActionCtx,
    args: {
      userId: string | undefined;
      threadId: string;
      promptMessageId: string;
      model: string | undefined;
      provider: string | undefined;
      result: GenerateObjectResult<unknown>;
      metadata?: Omit<MessageWithMetadata, "message">;
    },
  ): Promise<{ messages: MessageDoc[] }> {
    const { messages } = await serializeObjectResult(
      ctx,
      this.component,
      args.result,
      {
        model:
          args.model ??
          args.metadata?.model ??
          getModelName(this.options.languageModel),
        provider:
          args.provider ??
          args.metadata?.provider ??
          getProviderName(this.options.languageModel),
      },
    );
    const embeddings = await this.generateEmbeddings(
      ctx,
      { userId: args.userId, threadId: args.threadId },
      messages.map((m) => m.message),
    );

    return ctx.runMutation(this.component.messages.addMessages, {
      userId: args.userId,
      threadId: args.threadId,
      promptMessageId: args.promptMessageId,
      failPendingSteps: false,
      messages,
      embeddings,
      agentName: this.options.name,
    });
  }

  /**
   * Commit or rollback a message that was pending.
   * This is done automatically when saving messages by default.
   * If creating pending messages, you can call this when the full "transaction" is done.
   * @param ctx The ctx argument to your mutation or action.
   * @param args What message to save. Generally the parent message sent into
   *   the generateText call.
   */
  async finalizeMessage(
    ctx: RunMutationCtx,
    args: {
      messageId: string;
      result: { status: "failed"; error: string } | { status: "success" };
    },
  ): Promise<void> {
    await ctx.runMutation(this.component.messages.finalizeMessage, {
      messageId: args.messageId,
      result: args.result,
    });
  }

  /**
   * Update a message by its id.
   * @param ctx The ctx argument to your mutation or action.
   * @param args The message fields to update.
   */
  async updateMessage(
    ctx: RunMutationCtx,
    args: {
      /** The id of the message to update. */
      messageId: string;
      patch: {
        /** The message to replace the existing message. */
        message: ModelMessage | Message;
        /** The status to set on the message. */
        status: "success" | "error";
        /** The error message to set on the message. */
        error?: string;
        /**
         * These will override the fileIds in the message.
         * To remove all existing files, pass an empty array.
         * If passing in a new message, pass in the fileIds you explicitly want to keep
         * from the previous message, as the new files generated from the new message
         * will be added to the list.
         * If you pass undefined, it will not change the fileIds unless new
         * files are generated from the message. In that case, the new fileIds
         * will replace the old fileIds.
         */
        fileIds?: string[];
      };
    },
  ): Promise<void> {
    const { message, fileIds } = await serializeMessage(
      ctx,
      this.component,
      args.patch.message,
    );
    await ctx.runMutation(this.component.messages.updateMessage, {
      messageId: args.messageId,
      patch: {
        message,
        fileIds: args.patch.fileIds
          ? [...args.patch.fileIds, ...(fileIds ?? [])]
          : fileIds,
        status: args.patch.status === "success" ? "success" : "failed",
        error: args.patch.error,
      },
    });
  }

  /**
   * Delete multiple messages by their ids, including their embeddings
   * and reduce the refcount of any files they reference.
   * @param ctx The ctx argument to your mutation or action.
   * @param args The ids of the messages to delete.
   */
  async deleteMessages(
    ctx: RunMutationCtx,
    args: { messageIds: string[] },
  ): Promise<void> {
    await ctx.runMutation(this.component.messages.deleteByIds, args);
  }

  /**
   * Delete a single message by its id, including its embedding
   * and reduce the refcount of any files it references.
   * @param ctx The ctx argument to your mutation or action.
   * @param args The id of the message to delete.
   */
  async deleteMessage(
    ctx: RunMutationCtx,
    args: { messageId: string },
  ): Promise<void> {
    await ctx.runMutation(this.component.messages.deleteByIds, {
      messageIds: [args.messageId],
    });
  }

  /**
   * Delete a range of messages by their order and step order.
   * Each "order" is a set of associated messages in response to the message
   * at stepOrder 0.
   * The (startOrder, startStepOrder) is inclusive
   * and the (endOrder, endStepOrder) is exclusive.
   * To delete all messages at "order" 1, you can pass:
   * `{ startOrder: 1, endOrder: 2 }`
   * To delete a message at step (order=1, stepOrder=1), you can pass:
   * `{ startOrder: 1, startStepOrder: 1, endOrder: 1, endStepOrder: 2 }`
   * To delete all messages between (1, 1) up to and including (3, 5), you can pass:
   * `{ startOrder: 1, startStepOrder: 1, endOrder: 3, endStepOrder: 6 }`
   *
   * If it cannot do it in one transaction, it returns information you can use
   * to resume the deletion.
   * e.g.
   * ```ts
   * let isDone = false;
   * let lastOrder = args.startOrder;
   * let lastStepOrder = args.startStepOrder ?? 0;
   * while (!isDone) {
   *   // eslint-disable-next-line @typescript-eslint/no-explicit-any
   *   ({ isDone, lastOrder, lastStepOrder } = await agent.deleteMessageRange(
   *     ctx,
   *     {
   *       threadId: args.threadId,
   *       startOrder: lastOrder,
   *       startStepOrder: lastStepOrder,
   *       endOrder: args.endOrder,
   *       endStepOrder: args.endStepOrder,
   *     }
   *   ));
   * }
   * ```
   * @param ctx The ctx argument to your mutation or action.
   * @param args The range of messages to delete.
   */
  async deleteMessageRange(
    ctx: RunMutationCtx,
    args: {
      threadId: string;
      startOrder: number;
      startStepOrder?: number;
      endOrder: number;
      endStepOrder?: number;
    },
  ): Promise<{ isDone: boolean; lastOrder?: number; lastStepOrder?: number }> {
    return ctx.runMutation(this.component.messages.deleteByOrder, {
      threadId: args.threadId,
      startOrder: args.startOrder,
      startStepOrder: args.startStepOrder,
      endOrder: args.endOrder,
      endStepOrder: args.endStepOrder,
    });
  }

  /**
   * Delete a thread and all its messages and streams asynchronously (in batches)
   * This uses a mutation to that processes one page and recursively queues the
   * next page for deletion.
   * @param ctx The ctx argument to your mutation or action.
   * @param args The id of the thread to delete and optionally the page size to use for the delete.
   */
  async deleteThreadAsync(
    ctx: RunMutationCtx,
    args: { threadId: string; pageSize?: number },
  ): Promise<void> {
    await ctx.runMutation(this.component.threads.deleteAllForThreadIdAsync, {
      threadId: args.threadId,
      limit: args.pageSize,
    });
  }

  /**
   * Delete a thread and all its messages and streams synchronously.
   * This uses an action to iterate through all pages. If the action fails
   * partway, it will not automatically restart.
   * @param ctx The ctx argument to your action.
   * @param args The id of the thread to delete and optionally the page size to use for the delete.
   */
  async deleteThreadSync(
    ctx: RunActionCtx,
    args: { threadId: string; pageSize?: number },
  ): Promise<void> {
    await ctx.runAction(this.component.threads.deleteAllForThreadIdSync, {
      threadId: args.threadId,
      limit: args.pageSize,
    });
  }

  async _saveMessagesAndFetchContext<
    T extends {
      prompt?: string | (ModelMessage | Message)[];
      messages?: (ModelMessage | Message)[];
      system?: string;
      promptMessageId?: string;
      pendingMessageId?: string;
      model?: LanguageModel;
    },
  >(
    ctx: RunActionCtx,
    args: T,
    {
      userId: argsUserId,
      threadId,
      contextOptions,
      storageOptions,
    }: {
      userId: string | null | undefined;
      threadId: string | undefined;
    } & Options,
  ): Promise<{
    args: Extract<T, { model: LanguageModel; messages: ModelMessage[] }> &
      CallSettings;
    userId: string | undefined;
    promptMessageId: string | undefined;
    pendingMessageId: string | undefined;
    order: number | undefined;
    stepOrder: number | undefined;
    savedMessages: MessageDoc[] | undefined;
  }> {
    // If only a promptMessageId is provided, this will be empty.
    const messages = args.messages ?? [];
    const prompt: (ModelMessage | Message)[] = !args.prompt
      ? []
      : Array.isArray(args.prompt)
        ? args.prompt
        : [{ role: "user", content: args.prompt }];
    const userId =
      argsUserId ??
      (threadId &&
        (await ctx.runQuery(this.component.threads.getThread, { threadId }))
          ?.userId) ??
      undefined;
    // If only a messageId is provided, this will add that message to the end.
    const contextMessages = await this.fetchContextMessages(ctx, {
      userId,
      threadId,
      upToAndIncludingMessageId: args.promptMessageId,
      messages,
      contextOptions,
    });
    // If it was a promptMessageId, pop it off context messages
    // and add to the end of messages.
    const promptMessageIndex = args.promptMessageId
      ? contextMessages.findIndex((m) => m._id === args.promptMessageId)
      : -1;
    const promptMessage =
      promptMessageIndex !== -1
        ? contextMessages.splice(promptMessageIndex, 1)[0]
        : undefined;

    let promptMessageId = promptMessage?._id;
    let order = promptMessage?.order;
    let stepOrder = promptMessage?.stepOrder;
    let savedMessages = undefined;
    let pendingMessageId = undefined;
    if (threadId && storageOptions?.saveMessages !== "none") {
      let saved: { messages: MessageDoc[] };
      if (
        messages.length + prompt.length &&
        // If it was a promptMessageId, we don't want to save it again.
        (!args.promptMessageId || storageOptions?.saveMessages === "all")
      ) {
        const saveAll = storageOptions?.saveMessages === "all";
        const coreMessages = [...messages, ...prompt];
        const toSave = saveAll ? coreMessages : coreMessages.slice(-1);
        const metadata = Array.from({ length: toSave.length }, () => ({}));
        saved = await this.saveMessages(ctx, {
          threadId,
          userId,
          messages: [...toSave, { role: "assistant", content: [] }],
          metadata: [...metadata, { status: "pending" }],
          failPendingSteps: true,
          pendingMessageId: args.pendingMessageId,
        });
        promptMessageId = saved.messages.at(-2)!._id;
      } else {
        saved = await this.saveMessages(ctx, {
          threadId,
          userId,
          messages: [{ role: "assistant", content: [] }],
          metadata: [{ status: "pending" }],
          failPendingSteps: true,
          pendingMessageId: args.pendingMessageId,
        });
      }
      pendingMessageId = saved.messages.at(-1)!._id;
      order = saved.messages.at(-1)!.order;
      stepOrder = saved.messages.at(-1)!.stepOrder;
      // Don't return the pending message
      savedMessages = saved.messages.slice(0, -1);
    }

    if (promptMessage?.message) {
      if (!args.prompt) {
        // If they override the prompt, we skip the existing prompt message.
        messages.push(deserializeMessage(promptMessage.message));
      }
      // Lazily generate embeddings for the prompt message, if it doesn't have
      // embeddings yet. This can happen if the message was saved in a mutation
      // where the LLM is not available.
      if (!promptMessage.embeddingId && this.options.textEmbeddingModel) {
        await this._generateAndSaveEmbeddings(ctx, [promptMessage]);
      }
    }

    const prePrompt = contextMessages.map((m) =>
      deserializeMessage(m.message!),
    );
    let existingResponses: ModelMessage[] = [];
    if (promptMessageIndex !== -1) {
      // pull any messages that already responded to the prompt off
      // and add them after the prompt
      existingResponses = prePrompt.splice(promptMessageIndex);
    }

    let processedMessages = [
      ...prePrompt,
      ...messages,
      ...prompt,
      ...existingResponses,
    ];
    if (promptMessageIndex === -1) {
      processedMessages.push(...prompt);
    } else {
      // We add the prompt where the prompt message was
      processedMessages.splice(promptMessageIndex, 0, ...prompt);
    }

    // Process messages to inline localhost files (if not, file urls pointing to localhost will be sent to LLM providers)
    if (process.env.CONVEX_CLOUD_URL?.startsWith("http://127.0.0.1")) {
      processedMessages = await inlineMessagesFiles(processedMessages);
    }

    const { prompt: _, model, ...rest } = args;
    return {
      args: {
        ...this.options.callSettings,
        ...rest,
        model: model ?? this.options.languageModel,
        system: args.system ?? this.options.instructions,
        messages: processedMessages,
      } as Extract<T, { model: LanguageModel; messages: ModelMessage[] }> &
        CallSettings,
      userId,
      promptMessageId,
      pendingMessageId,
      savedMessages,
      order,
      stepOrder,
    };
  }

  async doEmbed(
    ctx: RunActionCtx,
    options: {
      userId: string | undefined;
      threadId: string | undefined;
      values: string[];
      abortSignal?: AbortSignal;
      headers?: Record<string, string>;
    },
  ): Promise<{ embeddings: number[][] }> {
    const embeddingModel = this.options.textEmbeddingModel;
    assert(
      embeddingModel,
      "a textEmbeddingModel is required to be set on the Agent that you're doing vector search with",
    );
    const result = await embedMany({
      ...this.options.callSettings,
      model: embeddingModel,
      values: options.values,
      abortSignal: options.abortSignal,
      headers: options.headers,
    });
    if (this.options.usageHandler && result.usage) {
      await this.options.usageHandler(ctx, {
        userId: options.userId,
        threadId: options.threadId,
        agentName: this.options.name,
        model: getModelName(embeddingModel),
        provider: getProviderName(embeddingModel),
        providerMetadata: undefined,
        usage: {
          inputTokens: result.usage.tokens,
          outputTokens: 0,
          totalTokens: result.usage.tokens,
        },
      });
    }
    return { embeddings: result.embeddings };
  }

  /**
   * WORKFLOW UTILITIES
   */

  /**
   * Create a mutation that creates a thread so you can call it from a Workflow.
   * e.g.
   * ```ts
   * // in convex/foo.ts
   * export const createThread = weatherAgent.createThreadMutation();
   *
   * const workflow = new WorkflowManager(components.workflow);
   * export const myWorkflow = workflow.define({
   *   args: {},
   *   handler: async (step) => {
   *     const { threadId } = await step.runMutation(internal.foo.createThread);
   *     // use the threadId to generate text, object, etc.
   *   },
   * });
   * ```
   * @returns A mutation that creates a thread.
   */
  createThreadMutation() {
    return internalMutationGeneric({
      args: {
        userId: v.optional(v.string()),
        title: v.optional(v.string()),
        summary: v.optional(v.string()),
      },
      handler: async (ctx, args): Promise<{ threadId: string }> => {
        const { threadId } = await this.createThread(ctx, args);
        return { threadId };
      },
    });
  }

  /**
   * Create an action out of this agent so you can call it from workflows or other actions
   * without a wrapping function.
   * @param spec Configuration for the agent acting as an action, including
   *   {@link ContextOptions}, {@link StorageOptions}, and {@link stopWhen}.
   */
  asTextAction<DataModel extends GenericDataModel>(
    spec: MaybeCustomCtx<CustomCtx, DataModel, AgentTools> & {
      /**
       * Whether to stream the text.
       * If false, it will generate the text in a single call. (default)
       * If true or {@link StreamingOptions}, it will stream the text from the LLM
       * and save the chunks to the database with the options you specify, or the
       * defaults if you pass true.
       */
      stream?: boolean | StreamingOptions;
      /**
       * When to stop generating text.
       * Defaults to the {@link Agent["options"].stopWhen} option.
       */
      stopWhen?: StopCondition<AgentTools> | Array<StopCondition<AgentTools>>;
    } & Options,
    overrides?: CallSettings,
  ) {
    return internalActionGeneric({
      args: vTextArgs,
      handler: async (ctx_, args) => {
        const stream =
          args.stream === true ? spec?.stream || true : (spec?.stream ?? false);
        const targetArgs = { userId: args.userId, threadId: args.threadId };
        const llmArgs = {
          stopWhen: spec?.stopWhen ?? this.options.stopWhen,
          ...overrides,
          ...omit(args, ["storageOptions", "contextOptions"]),
          messages: args.messages?.map(deserializeMessage),
          prompt: Array.isArray(args.prompt)
            ? args.prompt.map(deserializeMessage)
            : args.prompt,
          toolChoice: args.toolChoice as ToolChoice<AgentTools>,
        } satisfies StreamingTextArgs<AgentTools>;
        if (args.maxSteps) {
          llmArgs.stopWhen = stepCountIs(args.maxSteps);
        }
        const opts = {
          ...this.options,
          ...pick(spec, ["contextOptions", "storageOptions"]),
          ...pick(args, ["contextOptions", "storageOptions"]),
          saveStreamDeltas: stream,
        };
        const ctx = (
          spec?.customCtx
            ? { ...ctx_, ...spec.customCtx(ctx_, targetArgs, llmArgs) }
            : ctx_
        ) as UserActionCtx & CustomCtx;
        if (stream) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const result = await this.streamText<any>(
            ctx,
            targetArgs,
            llmArgs,
            opts,
          );
          await result.consumeStream();
          return {
            text: await result.text,
            promptMessageId: result.promptMessageId,
            order: result.order,
            finishReason: await result.finishReason,
            warnings: result.warnings,
            savedMessageIds: result.savedMessages?.map((m) => m._id) ?? [],
          };
        } else {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const res = await this.generateText<any>(
            ctx,
            targetArgs,
            llmArgs,
            opts,
          );
          return {
            text: res.text,
            promptMessageId: res.promptMessageId,
            order: res.order,
            finishReason: res.finishReason,
            warnings: res.warnings,
            savedMessageIds: res.savedMessages?.map((m) => m._id) ?? [],
          };
        }
      },
    });
  }
  /**
   * Create an action that generates an object out of this agent so you can call
   * it from workflows or other actions without a wrapping function.
   * @param spec Configuration for the agent acting as an action, including
   * the normal parameters to {@link generateObject}, plus {@link ContextOptions}
   * and stopWhen.
   */
  asObjectAction<T>(
    objectArgs: Omit<
      Parameters<typeof generateObject<FlexibleSchema<T>>>[0],
      "model"
    >,
    options?: Options & MaybeCustomCtx<CustomCtx, DataModel, AgentTools>,
  ) {
    return internalActionGeneric({
      args: vSafeObjectArgs,
      handler: async (ctx_, args) => {
        const { userId, threadId, callSettings, ...rest } = args;
        const overrides = pick(rest, ["contextOptions", "storageOptions"]);
        const targetArgs = { userId, threadId };
        const llmArgs = {
          ...objectArgs,
          ...callSettings,
          ...omit(rest, ["storageOptions", "contextOptions"]),
          messages: args.messages?.map(deserializeMessage),
          prompt: Array.isArray(args.prompt)
            ? args.prompt.map(deserializeMessage)
            : args.prompt,
        } as Omit<Parameters<typeof generateObject>[0], "model">;
        const ctx = (
          options?.customCtx
            ? { ...ctx_, ...options.customCtx(ctx_, targetArgs, llmArgs) }
            : ctx_
        ) as UserActionCtx & CustomCtx;
        const value = await this.generateObject(ctx, targetArgs, llmArgs, {
          ...this.options,
          ...options,
          ...overrides,
        });
        return {
          object: convexToJson(value.object as Value) as T,
          promptMessageId: value.promptMessageId,
          order: value.order,
          finishReason: value.finishReason,
          warnings: value.warnings,
          savedMessageIds: value.savedMessages?.map((m) => m._id) ?? [],
        };
      },
    });
  }

  /**
   * Save messages to the thread.
   * Useful as a step in Workflows, e.g.
   * ```ts
   * const saveMessages = agent.asSaveMessagesMutation();
   *
   * const myWorkflow = workflow.define({
   *   args: {...},
   *   handler: async (step, args) => {
   *     // do things to create (but not save)messages
   *     const { messageIds } = await step.runMutation(internal.foo.saveMessages, {
   *       threadId: args.threadId,
   *       messages: args.messages,
   *     });
   *     // ...
   *   },
   * })
   * ```
   * @returns A mutation that can be used to save messages to the thread.
   */
  asSaveMessagesMutation() {
    return internalMutationGeneric({
      args: {
        threadId: v.string(),
        userId: v.optional(v.string()),
        promptMessageId: v.optional(v.string()),
        messages: v.array(vMessageWithMetadata),
        failPendingSteps: v.optional(v.boolean()),
        embeddings: v.optional(vMessageEmbeddings),
      },
      handler: async (ctx, args) => {
        const { messages } = await this.saveMessages(ctx, {
          ...args,
          messages: args.messages.map((m) => deserializeMessage(m.message)),
          metadata: args.messages.map(({ message: _, ...m }) => m),
          skipEmbeddings: true,
        });
        return {
          lastMessageId: messages.at(-1)!._id,
          messages: messages.map((m) => pick(m, ["_id", "order", "stepOrder"])),
        };
      },
    });
  }
}

async function willContinue(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  steps: StepResult<any>[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stopWhen: StopCondition<any> | Array<StopCondition<any>> | undefined,
): Promise<boolean> {
  const step = steps.at(-1)!;
  // we aren't doing another round after a tool result
  // TODO: whether to handle continuing after too much context used..
  if (step.finishReason !== "tool-calls") return false;
  // we don't have a tool result, so we'll wait for more
  if (step.toolCalls.length > step.toolResults.length) return false;
  if (Array.isArray(stopWhen)) {
    return (await Promise.all(stopWhen.map(async (s) => s({ steps })))).every(
      (stop) => !stop,
    );
  }
  return !(await stopWhen?.({ steps }));
}

function errorToString(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
