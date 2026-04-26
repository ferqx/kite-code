import { describe, expect, test } from "bun:test";
import { withTransientModelRetry } from "../src/model/deepseek";

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
});
