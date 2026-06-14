import React, { useRef, type ReactNode } from "react";
import { Box, Static } from "ink";
import { useInput } from "ink";
import type { OutputBlock } from "./types";
import BlockRenderer from "./components/BlockRenderer";

export { changePrefix } from "./components/BlockRenderer";
export { toolColor } from "./components/render-utils";
export { useStaticContent } from "./render/useStaticContent";
export type { StaticContentResult } from "./render/useStaticContent";

interface OutputAreaProps {
  staticItems?: unknown[];
  staticKey?: string;
  staticHeader?: ReactNode;
  mergedStaticBlocks: OutputBlock[];
  /** Blocks kept in the dynamic tree — may still mutate (tool running, streaming text, etc.) */
  activeDynamicBlocks: OutputBlock[];
  onToggleReason: (id: number) => void;
  onToggleToolExpand?: (id: number) => void;
  onToggleSubagentExpand?: (id: number) => void;
  overlayActive?: boolean;
  /** 主 agent 等待审批时隐藏工具计时器 / Hide tool timer when awaiting approval */
  awaitingApproval?: boolean;
}

/**
 * OutputArea renders <Static> (immutable settled blocks + header) inline,
 * and all mutable blocks in the dynamic tree. Blocks only enter <Static>
 * once they become truly immutable (tool done, text complete, etc.).
 */
export default function OutputArea({
  staticItems,
  staticKey,
  staticHeader,
  activeDynamicBlocks,
  mergedStaticBlocks,
  onToggleReason,
  onToggleToolExpand,
  onToggleSubagentExpand,
  overlayActive,
  awaitingApproval,
}: OutputAreaProps) {
  const onToggleReasonRef = useRef(onToggleReason);
  onToggleReasonRef.current = onToggleReason;
  const onToggleToolRef = useRef(onToggleToolExpand);
  onToggleToolRef.current = onToggleToolExpand;
  const onToggleSubagentRef = useRef(onToggleSubagentExpand);
  onToggleSubagentRef.current = onToggleSubagentExpand;
  const dynamicBlocksRef = useRef(activeDynamicBlocks);
  dynamicBlocksRef.current = activeDynamicBlocks;

  // Arrow key Enter-to-toggle on the last dynamic block
  useInput(
    (
      _input: unknown,
      key: { upArrow?: boolean; downArrow?: boolean; return?: boolean },
    ) => {
      const blocks = dynamicBlocksRef.current;
      const last = blocks[blocks.length - 1];
      if (!last) return;
      if (key.return) {
        if (last.kind === "reason") {
          onToggleReasonRef.current?.(last.id);
        } else if (last.kind === "tool_card") {
          onToggleToolRef.current?.(last.id);
        } else if (last.kind === "subagent") {
          onToggleSubagentRef.current?.(last.id);
        }
      }
    },
    { isActive: !overlayActive },
  );

  return (
    <Box flexDirection="column">
      <Box height={0} overflow="hidden">
        {staticItems && staticKey && (
          <Static key={staticKey} items={staticItems}>
            {(item, index) => {
              if (index === 0) {
                return <React.Fragment key="header">{staticHeader}</React.Fragment>;
              }
              const block = mergedStaticBlocks[index - 1];
              if (!block) return null;
              const prevBlock = index > 1 ? mergedStaticBlocks[index - 2] : undefined;
              return (
                <BlockRenderer
                  key={block.id}
                  block={block}
                  isFocused={false}
                  index={index - 1}
                  prevBlock={prevBlock}
                  awaitingApproval={false}
                />
              );
            }}
          </Static>
        )}
      </Box>
      {activeDynamicBlocks.map((block, i) => {
        const prevBlock =
          i > 0
            ? activeDynamicBlocks[i - 1]
            : mergedStaticBlocks.at(-1);
        return (
          <BlockRenderer
            key={block.id}
            block={block}
            isFocused={false}
            index={mergedStaticBlocks.length + i}
            prevBlock={prevBlock}
            awaitingApproval={awaitingApproval}
          />
        );
      })}
    </Box>
  );
}
