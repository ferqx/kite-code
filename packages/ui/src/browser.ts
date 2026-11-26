/** Shared presentation used by the read-only browser without loading the desktop entry. */
export { ContextPanel } from './context';
export { Badge } from './desktop/components/ui/badge';
export { Spinner } from './desktop/components/ui/spinner';
export {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './desktop/components/ui/tooltip';
export { MessageCopyButton } from './desktop/MessageCopyButton';
export { SafeMessageMarkdown } from './markdown';
export {
  type ModelInputDirectory,
  type ModelInputIdentity,
  type ModelInputPort,
  type ModelInputSnapshot,
  ModelInputs,
  readModelDirectory,
} from './model-input';
export { ModelOutputMessage, modelOutputTerminalObserved } from './model-output';
export { completeRunReplies } from './run-reply-copy';
