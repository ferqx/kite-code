import type { AgentEvent } from "./events";
import type { InterruptPayload, UserAction } from "./actions";

export interface UserInputProvider {
  onEvent(event: AgentEvent): void;
  requestAction(payload: InterruptPayload): Promise<UserAction>;
  setup?(): Promise<void>;
  teardown?(): Promise<void>;
}
