import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  type MockedFunction,
} from "vitest";
import type { ModelMessage } from "ai";
import { defineSchema } from "convex/server";
import type { MessageDoc } from "../validators.js";
import type { RunActionCtx, RunQueryCtx } from "./types.js";
import {
  fetchContextWithPrompt,
  fetchContextMessages,
  filterOutOrphanedToolMessages,
  getPromptArray,
} from "./search.js";
import { components, initConvexTest } from "./setup.test.js";
import { createThread } from "./threads.js";
import { saveMessages } from "./messages.js";

// Helper to create mock MessageDoc
const createMockMessageDoc = (
  id: string,
  role: "user" | "assistant" | "tool" | "system",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content: any,
  order: number = 1,
): MessageDoc => ({
  _id: id,
  _creationTime: Date.now(),
  userId: "test-user",
  threadId: "test-thread",
  order,
  stepOrder: order,
  status: "success",
  tool: false,
  message: { role, content },
});

const schema = defineSchema({});

describe("search.ts", () => {
  let t = initConvexTest(schema);
  let mockCtx: RunActionCtx;
  let ctx: RunActionCtx;

  beforeEach(() => {
    vi.clearAllMocks();
    t = initConvexTest(schema);
    ctx = {
      runQuery: t.query,
      runAction: t.action,
      runMutation: t.mutation,
    } as RunActionCtx;

    mockCtx = {
      runQuery: vi.fn(),
      runAction: vi.fn(),
      runMutation: vi.fn(),
    } satisfies RunActionCtx;

    // Mock process.env to avoid file inlining in tests
    process.env.CONVEX_CLOUD_URL = "https://example.convex.cloud";
  });

  describe("getPromptArray", () => {
    it("should return empty array for undefined prompt", () => {
      expect(getPromptArray(undefined)).toEqual([]);
    });

    it("should return array as-is for array prompt", () => {
      const prompt: ModelMessage[] = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
      ];
      expect(getPromptArray(prompt)).toEqual(prompt);
    });

    it("should convert string prompt to user message", () => {
      const prompt = "Hello world";
      expect(getPromptArray(prompt)).toEqual([
        { role: "user", content: "Hello world" },
      ]);
    });
  });

  describe("filterOutOrphanedToolMessages", () => {
    it("should keep non-tool messages", () => {
      const messages: MessageDoc[] = [
        {
          _id: "1",
          message: { role: "user", content: "Hello" },
          order: 1,
        } as MessageDoc,
        {
          _id: "2",
          message: { role: "assistant", content: "Hi!" },
          order: 2,
        } as MessageDoc,
      ];

      const result = filterOutOrphanedToolMessages(messages);
      expect(result).toHaveLength(2);
      expect(result).toEqual(messages);
    });

    it("should keep tool messages with corresponding tool calls", () => {
      const messages: MessageDoc[] = [
        {
          _id: "1",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "I'll help you with that" },
              {
                type: "tool-call",
                toolCallId: "call_123",
                toolName: "test",
                args: {},
              },
            ],
          },
          order: 1,
        } as MessageDoc,
        {
          _id: "2",
          message: {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call_123",
                result: "success",
              },
            ],
          },
          order: 2,
        } as MessageDoc,
      ];

      const result = filterOutOrphanedToolMessages(messages);
      expect(result).toHaveLength(2);
      expect(result).toEqual(messages);
    });

    it("should filter out orphaned tool messages", () => {
      const messages: MessageDoc[] = [
        {
          _id: "1",
          message: { role: "user", content: "Hello" },
          order: 1,
        } as MessageDoc,
        {
          _id: "2",
          message: {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call_orphaned",
                result: "orphaned",
              },
            ],
          },
          order: 2,
        } as MessageDoc,
      ];

      const result = filterOutOrphanedToolMessages(messages);
      expect(result).toHaveLength(1);
      expect(result[0]._id).toBe("1");
    });
  });

  describe("fetchContextMessages", () => {
    it("should throw error if neither userId nor threadId provided", async () => {
      await expect(
        fetchContextMessages(mockCtx, components.agent, {
          userId: undefined,
          threadId: undefined,
          contextOptions: {},
        }),
      ).rejects.toThrow("Specify userId or threadId");
    });

    it("should fetch recent messages when threadId provided", async () => {
      const mockPage = [
        createMockMessageDoc("2", "assistant", "Hi!", 2),
        createMockMessageDoc("1", "user", "Hello", 1),
      ];

      (
        mockCtx.runQuery as MockedFunction<RunActionCtx["runQuery"]>
      ).mockResolvedValue({
        page: mockPage,
      });

      const result = await fetchContextMessages(mockCtx, components.agent, {
        userId: undefined,
        threadId: "thread123",
        contextOptions: { recentMessages: 10 },
      });

      expect(mockCtx.runQuery).toHaveBeenCalledWith(expect.anything(), {
        threadId: "thread123",
        paginationOpts: { numItems: 10, cursor: null },
        order: "desc",
        excludeToolMessages: undefined,
        statuses: ["success"],
        upToAndIncludingMessageId: undefined,
      });

      expect(result.length).toBe(2);
      expect(result[0]._id).toBe("1"); // Should be reversed back to asc order
      expect(result[1]._id).toBe("2");
    });

    it("should skip recent messages when recentMessages is 0", async () => {
      const result = await fetchContextMessages(mockCtx, components.agent, {
        userId: "user123",
        threadId: "thread123",
        contextOptions: { recentMessages: 0 },
      });

      expect(mockCtx.runQuery).not.toHaveBeenCalled();
      expect(result).toEqual([]);
    });

    it("should perform search when searchOptions provided", async () => {
      const searchResults = [
        createMockMessageDoc("search1", "user", "Search result", 0),
      ];

      (
        mockCtx.runAction as MockedFunction<RunActionCtx["runAction"]>
      ).mockResolvedValue(searchResults);

      const result = await fetchContextMessages(mockCtx, components.agent, {
        userId: "user123",
        threadId: "thread123",
        searchText: "test query",
        contextOptions: {
          recentMessages: 0,
          searchOptions: {
            textSearch: true,
            limit: 5,
          },
        },
      });

      expect(result.length).toBe(1);
      expect(result[0]._id).toBe("search1");
    });

    it("should throw error when trying to search in non-action context", async () => {
      const mockQueryCtx = {
        runQuery: vi.fn().mockResolvedValue({ page: [] }),
        // No runAction method
      } as RunQueryCtx;

      await expect(
        fetchContextMessages(mockQueryCtx, components.agent, {
          userId: "user123",
          threadId: "thread123",
          contextOptions: {
            searchOptions: {
              textSearch: true,
              limit: 5,
            },
          },
        }),
      ).rejects.toThrow("searchUserMessages only works in an action");
    });
  });

  describe("fetchContextWithPrompt", () => {
    const baseArgs = {
      userId: "user123",
      threadId: "thread123",
      agentName: "test-agent",
      contextOptions: {},
      usageHandler: undefined,
      callSettings: {},
    };

    beforeEach(() => {
      // Mock fetchContextMessages to return empty array by default
      vi.mocked(mockCtx.runQuery).mockResolvedValue({ page: [] });
      vi.mocked(mockCtx.runAction).mockResolvedValue([]);
    });

    it("should handle string prompt correctly", async () => {
      const result = await fetchContextWithPrompt(mockCtx, components.agent, {
        ...baseArgs,
        prompt: "Hello, how are you?",
        messages: undefined,
        promptMessageId: undefined,
      });

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toEqual({
        role: "user",
        content: "Hello, how are you?",
      });
      expect(result.order).toBeUndefined();
      expect(result.stepOrder).toBeUndefined();
    });

    it("should handle array prompt correctly", async () => {
      const promptMessages: ModelMessage[] = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
        { role: "user", content: "How are you?" },
      ];

      const result = await fetchContextWithPrompt(mockCtx, components.agent, {
        ...baseArgs,
        prompt: promptMessages,
        messages: undefined,
        promptMessageId: undefined,
      });

      expect(result.messages).toHaveLength(3);
      expect(result.messages).toEqual(promptMessages);
    });

    it("should combine context messages with prompt", async () => {
      const contextMessages: MessageDoc[] = [
        {
          _id: "ctx1",
          message: { role: "user", content: "Context message 1" },
          order: 1,
        } as MessageDoc,
        {
          _id: "ctx2",
          message: { role: "assistant", content: "Context response 1" },
          order: 2,
        } as MessageDoc,
      ];

      // Mock the internal fetchContextMessages call
      vi.mocked(mockCtx.runQuery).mockResolvedValue({
        page: [...contextMessages].reverse(),
      });

      const result = await fetchContextWithPrompt(mockCtx, components.agent, {
        ...baseArgs,
        prompt: "New prompt",
        messages: undefined,
        promptMessageId: undefined,
        contextOptions: { recentMessages: 10 },
      });

      expect(result.messages).toHaveLength(3);
      expect(result.messages[0].content).toBe("Context message 1");
      expect(result.messages[1].content).toBe("Context response 1");
      expect(result.messages[2]).toEqual({
        role: "user",
        content: "New prompt",
      });
    });

    it("should handle input messages correctly", async () => {
      const inputMessages: ModelMessage[] = [
        { role: "user", content: "Input message 1" },
        { role: "assistant", content: "Input response 1" },
      ];

      const result = await fetchContextWithPrompt(mockCtx, components.agent, {
        ...baseArgs,
        prompt: "Final prompt",
        messages: inputMessages,
        promptMessageId: undefined,
      });

      expect(result.messages).toHaveLength(3);
      expect(result.messages[0]).toEqual(inputMessages[0]);
      expect(result.messages[1]).toEqual(inputMessages[1]);
      expect(result.messages[2]).toEqual({
        role: "user",
        content: "Final prompt",
      });
    });

    it("should splice prompt messages when promptMessageId provided", async () => {
      const contextMessages: MessageDoc[] = [
        {
          _id: "msg1",
          message: { role: "user", content: "Before prompt" },
          order: 1,
        } as MessageDoc,
        {
          _id: "prompt-msg",
          message: { role: "user", content: "Original prompt" },
          order: 2,
        } as MessageDoc,
        {
          _id: "msg3",
          message: { role: "assistant", content: "After prompt" },
          order: 3,
        } as MessageDoc,
      ];

      vi.mocked(mockCtx.runQuery).mockResolvedValue({
        page: [...contextMessages].reverse(),
      });

      const result = await fetchContextWithPrompt(mockCtx, components.agent, {
        ...baseArgs,
        prompt: "New replacement prompt",
        messages: undefined,
        promptMessageId: "prompt-msg",
        contextOptions: { recentMessages: 10 },
      });

      expect(result.messages).toHaveLength(3);
      expect(result.messages[0].content).toBe("Before prompt");
      expect(result.messages[1]).toEqual({
        role: "user",
        content: "New replacement prompt",
      });
      expect(result.messages[2].content).toBe("After prompt");
      expect(result.order).toBe(2);
    });

    it("should use original prompt message when no new prompt provided", async () => {
      const contextMessages: MessageDoc[] = [
        {
          _id: "msg1",
          message: { role: "user", content: "Before prompt" },
          order: 1,
        } as MessageDoc,
        {
          _id: "prompt-msg",
          message: { role: "user", content: "Original prompt" },
          order: 2,
        } as MessageDoc,
        {
          _id: "msg3",
          message: { role: "assistant", content: "After prompt" },
          order: 3,
        } as MessageDoc,
      ];

      vi.mocked(mockCtx.runQuery).mockResolvedValue({
        page: [...contextMessages].reverse(),
      });

      const result = await fetchContextWithPrompt(mockCtx, components.agent, {
        ...baseArgs,
        prompt: undefined,
        messages: undefined,
        promptMessageId: "prompt-msg",
        contextOptions: { recentMessages: 10 },
      });

      expect(result.messages).toHaveLength(3);
      expect(result.messages[0].content).toBe("Before prompt");
      expect(result.messages[1].content).toBe("Original prompt");
      expect(result.messages[2].content).toBe("After prompt");
    });

    it("should handle complex message ordering correctly", async () => {
      const contextMessages: MessageDoc[] = [
        {
          _id: "ctx1",
          message: { role: "user", content: "Context 1" },
          order: 1,
        } as MessageDoc,
        {
          _id: "prompt-msg",
          message: { role: "user", content: "Prompt" },
          order: 3,
        } as MessageDoc,
        {
          _id: "ctx2",
          message: { role: "assistant", content: "Context 2" },
          order: 5,
        } as MessageDoc,
      ];

      vi.mocked(mockCtx.runQuery).mockResolvedValue({
        page: [...contextMessages].reverse(),
      });

      const inputMessages: ModelMessage[] = [
        { role: "user", content: "Input message" },
      ];

      const result = await fetchContextWithPrompt(mockCtx, components.agent, {
        ...baseArgs,
        prompt: "New prompt",
        messages: inputMessages,
        promptMessageId: "prompt-msg",
        contextOptions: { recentMessages: 10 },
      });

      expect(result.messages).toHaveLength(4);
      expect(result.messages[0].content).toBe("Context 1"); // Pre-prompt
      expect(result.messages[1].content).toBe("Input message"); // Input messages
      expect(result.messages[2].content).toBe("New prompt"); // New prompt
      expect(result.messages[3].content).toBe("Context 2"); // Post-prompt
    });

    it("should handle empty context and messages", async () => {
      const result = await fetchContextWithPrompt(mockCtx, components.agent, {
        ...baseArgs,
        prompt: undefined,
        messages: undefined,
        promptMessageId: undefined,
      });

      expect(result.messages).toHaveLength(0);
      expect(result.order).toBeUndefined();
      expect(result.stepOrder).toBeUndefined();
    });
  });

  describe("fetchContextWithPrompt - Integration Tests", () => {
    const baseArgs = {
      userId: "user123",
      threadId: "thread123",
      agentName: "test-agent",
      contextOptions: {},
      usageHandler: undefined,
      callSettings: {},
    };

    async function createTestThread(userId: string) {
      return await t.run(async (mutCtx) => {
        return await createThread(mutCtx, components.agent, {
          userId,
        });
      });
    }

    async function createTestMessages(
      threadId: string,
      userId: string,
      messages: Array<{
        role: "user" | "assistant";
        content: string;
        order: number;
      }>,
    ) {
      await t.run(async (mutCtx) => {
        await saveMessages(mutCtx, components.agent, {
          threadId,
          userId,
          messages: messages.map((msg) => ({
            role: msg.role,
            content: msg.content,
          })),
          metadata: messages.map((msg) => ({
            order: msg.order,
            stepOrder: msg.order,
            status: "success" as const,
          })),
        });
      });
    }

    it("should fetch and combine real messages with prompt", async () => {
      const threadId = await createTestThread("user123");

      await createTestMessages(threadId, "user123", [
        { role: "user", content: "Hello", order: 1 },
        { role: "assistant", content: "Hi there!", order: 2 },
        { role: "user", content: "How are you?", order: 3 },
      ]);

      const result = await fetchContextWithPrompt(ctx, components.agent, {
        ...baseArgs,
        threadId,
        prompt: "What's the weather?",
        messages: undefined,
        promptMessageId: undefined,
        contextOptions: { recentMessages: 10 },
      });

      expect(result.messages).toHaveLength(4);
      expect(result.messages[0].content).toBe("Hello");
      expect(result.messages[1].content).toBe("Hi there!");
      expect(result.messages[2].content).toBe("How are you?");
      expect(result.messages[3]).toEqual({
        role: "user",
        content: "What's the weather?",
      });
    });

    it("should handle prompt message replacement in real data", async () => {
      const threadId = await createTestThread("user456");

      // Create messages and capture the prompt message ID
      const messages = [
        { role: "user" as const, content: "Before prompt" },
        { role: "user" as const, content: "Original prompt" },
        { role: "assistant" as const, content: "Assistant response" },
      ];

      const { messages: savedMessages } = await t.run(async (mutCtx) => {
        return await saveMessages(mutCtx, components.agent, {
          threadId,
          userId: "user456",
          messages: messages.map((msg) => ({
            role: msg.role,
            content: msg.content,
          })),
          metadata: messages.map(() => ({})),
        });
      });

      const promptMessageId = savedMessages[1]._id; // The prompt message

      const result = await fetchContextWithPrompt(ctx, components.agent, {
        ...baseArgs,
        userId: "user456",
        threadId,
        prompt: "New replacement prompt",
        messages: undefined,
        promptMessageId,
        contextOptions: { recentMessages: 10 },
      });

      expect(result.messages).toHaveLength(3);
      expect(result.messages[0].content).toBe("Before prompt");
      expect(result.messages[1]).toEqual({
        role: "user",
        content: "New replacement prompt",
      });
      expect(result.messages[2].content).toBe("Assistant response");
      // The prompt is the second user message, each on a new order.
      expect(result.order).toBe(1);
      expect(result.stepOrder).toBe(0);
    });

    it("should combine input messages with context and prompt", async () => {
      const threadId = await createTestThread("user789");

      await createTestMessages(threadId, "user789", [
        { role: "user", content: "Context message", order: 1 },
        { role: "assistant", content: "Context response", order: 2 },
      ]);

      const inputMessages: ModelMessage[] = [
        { role: "user", content: "Input message 1" },
        { role: "user", content: "Input message 2" },
      ];

      const result = await fetchContextWithPrompt(ctx, components.agent, {
        ...baseArgs,
        userId: "user789",
        threadId,
        prompt: "Final prompt",
        messages: inputMessages,
        promptMessageId: undefined,
        contextOptions: { recentMessages: 10 },
      });

      expect(result.messages).toHaveLength(5);
      expect(result.messages[0].content).toBe("Context message");
      expect(result.messages[1].content).toBe("Context response");
      expect(result.messages[2].content).toBe("Input message 1");
      expect(result.messages[3].content).toBe("Input message 2");
      expect(result.messages[4]).toEqual({
        role: "user",
        content: "Final prompt",
      });
    });

    it("should respect recentMessages limit", async () => {
      const threadId = await createTestThread("user999");

      // Create 5 messages but only fetch the most recent 2
      await createTestMessages(threadId, "user999", [
        { role: "user", content: "Message 1", order: 1 },
        { role: "assistant", content: "Response 1", order: 2 },
        { role: "user", content: "Message 2", order: 3 },
        { role: "assistant", content: "Response 2", order: 4 },
        { role: "user", content: "Message 3", order: 5 },
      ]);

      const result = await fetchContextWithPrompt(ctx, components.agent, {
        ...baseArgs,
        userId: "user999",
        threadId,
        prompt: "New prompt",
        messages: undefined,
        promptMessageId: undefined,
        contextOptions: { recentMessages: 2 }, // Only fetch 2 most recent
      });

      expect(result.messages).toHaveLength(3); // 2 context + 1 prompt
      expect(result.messages[0].content).toBe("Response 2"); // 4th message
      expect(result.messages[1].content).toBe("Message 3"); // 5th message
      expect(result.messages[2]).toEqual({
        role: "user",
        content: "New prompt",
      });
    });

    it("should handle empty thread gracefully", async () => {
      const threadId = await createTestThread("user000");

      // Don't create any messages

      const result = await fetchContextWithPrompt(ctx, components.agent, {
        ...baseArgs,
        userId: "user000",
        threadId,
        prompt: "Only prompt",
        messages: undefined,
        promptMessageId: undefined,
        contextOptions: { recentMessages: 10 },
      });

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toEqual({
        role: "user",
        content: "Only prompt",
      });
    });
  });
});
