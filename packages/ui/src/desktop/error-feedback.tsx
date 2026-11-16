import { createContext, useContext } from 'react';

/** Error delivery only. The host owns presentation, lifetime and scope. */
export const ErrorFeedbackContext = createContext<((message: string) => void) | undefined>(
  undefined,
);

export function useErrorFeedback(onError?: (message: string) => void) {
  const inherited = useContext(ErrorFeedbackContext);
  return onError ?? inherited;
}
