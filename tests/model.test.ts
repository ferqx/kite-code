import { describe, expect, test } from "bun:test";
import { ChatDeepSeek } from "@langchain/deepseek";
import { ChatOllama } from "@langchain/ollama";
import { ChatOpenAI } from "@langchain/openai";
import { AIMessage } from "@langchain/core/messages";
import type { AgentConfig } from "../src/config/index";
import { createDeepSeekModel, withTransientModelRetry } from "../src/model/deepseek";
import { createChatModel } from "../src/model/factory";

describe("model transient retry", () => {
  test("retries transient socket errors before succeeding", async () => {
    let attempts = 0;
    const delays: number[] = [];

    const result = await withTransientModelRetry(
      async () => {
        attempts++;
        if (attempts < 3) {
          throw Object.assign(new Error("FailedToOpenSocket"), {
            code: "FailedToOpenSocket",
          });
        }
        return "ok";
      },
      {
        initialDelayMs: 10,
        jitterMs: 0,
        sleep: async (delay) => {
          delays.push(delay);
        },
      },
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
    expect(delays).toEqual([10, 20]);
  });

  test("retries OpenAI connection errors with nested socket causes", async () => {
    let attempts = 0;

    const result = await withTransientModelRetry(
      async () => {
        attempts++;
        if (attempts === 1) {
          throw Object.assign(new Error("Connection error."), {
            cause: {
              code: "FailedToOpenSocket",
              message: "Was there a typo in the url or port?",
            },
          });
        }
        return "ok";
      },
      {
        initialDelayMs: 1,
        jitterMs: 0,
        sleep: async () => {},
      },
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });

  test("does not retry non-transient API errors", async () => {
    let attempts = 0;
    const error = Object.assign(new Error("Unauthorized"), { status: 401 });

    await expect(
      withTransientModelRetry(
        async () => {
          attempts++;
          throw error;
        },
        {
          sleep: async () => {
            throw new Error("sleep should not be called");
          },
        },
      ),
    ).rejects.toBe(error);
    expect(attempts).toBe(1);
  });

  test("rethrows the last transient error after max attempts", async () => {
    let attempts = 0;
    const errors = [
      Object.assign(new Error("first reset"), { code: "ECONNRESET" }),
      Object.assign(new Error("second reset"), { code: "ECONNRESET" }),
      Object.assign(new Error("final reset"), { code: "ECONNRESET" }),
    ];

    await expect(
      withTransientModelRetry(
        async () => {
          throw errors[attempts++];
        },
        {
          maxAttempts: 3,
          initialDelayMs: 1,
          jitterMs: 0,
          sleep: async () => {},
        },
      ),
    ).rejects.toBe(errors[2]);
    expect(attempts).toBe(3);
  });

  test("passes back empty DeepSeek reasoning content when the provider returns it", async () => {
    const model = createDeepSeekModel({
      providerName: "deepseek",
      providerType: "deepseek",
      apiKey: "sk-test",
      baseURL: "https://api.deepseek.com/v1",
      modelName: "deepseek-v4-flash",
    }) as any;
    const rawToolCall = {
      id: "call-empty-reasoning",
      type: "function" as const,
      function: {
        name: "shell_execute",
        arguments: JSON.stringify({ command: "pwd" }),
      },
    };
    let capturedRequest: any;

    model._originalMessages = [
      new AIMessage({
        content: "",
        additional_kwargs: {
          reasoning_content: "",
          tool_calls: [rawToolCall],
        },
        tool_calls: [
          {
            id: "call-empty-reasoning",
            name: "shell_execute",
            args: { command: "pwd" },
          },
        ],
      }),
    ];
    model.client = {
      chat: {
        completions: {
          create: async (request: any) => {
            capturedRequest = request;
            return {
              id: "chatcmpl-test",
              object: "chat.completion",
              created: 0,
              model: "deepseek-v4-flash",
              choices: [],
            };
          },
        },
      },
    };

    await model.completionWithRetry({
      model: "deepseek-v4-flash",
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [rawToolCall],
        },
      ],
    });

    expect(capturedRequest.messages[0]).toHaveProperty("reasoning_content", "");
  });
});

describe("model provider factory", () => {
  test("uses the DeepSeek LangChain adapter for deepseek providers", () => {
    const model = createChatModel({
      providerName: "deepseek",
      providerType: "deepseek",
      apiKey: "sk-test",
      baseURL: "https://api.deepseek.com/v1",
      modelName: "deepseek-chat",
    });

    expect(model).toBeInstanceOf(ChatDeepSeek);
    expect(model.model).toBe("deepseek-chat");
  });

  test("uses ChatOpenAI for OpenAI-compatible providers", () => {
    const config: AgentConfig = {
      providerName: "siliconflow",
      providerType: "openai-compatible",
      apiKey: "sk-compatible",
      baseURL: "https://api.siliconflow.cn/v1",
      modelName: "Qwen/Qwen3-Coder",
    };

    const model = createChatModel(config);

    expect(model).toBeInstanceOf(ChatOpenAI);
    if (!(model instanceof ChatOpenAI)) {
      throw new Error("Expected ChatOpenAI model");
    }
    expect(model.model).toBe("Qwen/Qwen3-Coder");
    expect(model.clientConfig.baseURL).toBe("https://api.siliconflow.cn/v1");
  });

  test("uses ChatOllama for Ollama providers", () => {
    const config: AgentConfig = {
      providerName: "ollama",
      providerType: "ollama",
      apiKey: "",
      baseURL: "http://localhost:11434",
      modelName: "qwen2.5-coder:7b",
    };

    const model = createChatModel(config);

    expect(model).toBeInstanceOf(ChatOllama);
    if (!(model instanceof ChatOllama)) {
      throw new Error("Expected ChatOllama model");
    }
    expect(model.model).toBe("qwen2.5-coder:7b");
    expect(model.baseUrl).toBe("http://localhost:11434");
  });
});
