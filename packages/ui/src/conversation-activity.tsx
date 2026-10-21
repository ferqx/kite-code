import { createContext, useContext } from 'react';

/** Display retention never restores a host's read or operation admission. */
export type RetainedConversationResource = {
  bytes: number;
  release: () => void;
  releaseOnWindowHide?: boolean;
};
export type ConversationResourceRetention = {
  retain: (resource: RetainedConversationResource) => () => void;
  isPaused: () => boolean;
};
type ConversationActivity = {
  readActive: boolean;
  resume: number;
  retention?: ConversationResourceRetention;
};
export const ConversationActivityContext = createContext<ConversationActivity>({
  readActive: true,
  resume: 0,
});

export const useConversationActivity = () => useContext(ConversationActivityContext);
export const useConversationReadActive = () => useConversationActivity().readActive;

/** Resources belong to the bounded cache entry, rather than its paused effects. */
export const useConversationResourceRetention = () => useConversationActivity().retention;
