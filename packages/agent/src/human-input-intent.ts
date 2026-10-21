import type { HumanInputProposal, HumanWorkIdentity } from './storage/human-work-control';

export interface HumanWorkCandidate extends HumanWorkIdentity {
  content: string;
}
/** Material supplied for analysis never becomes a current control instruction. */
export function currentHumanInstruction(content: string): string {
  return content
    .replace(/```.*?(?:```|$)/gs, '')
    .replace(/~~~.*?(?:~~~|$)/gs, '')
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n')
    .replace(/[“「『][^”」』]*[”」』]/g, '')
    .replace(/"[^"\n]*"|'[^'\n]*'|`[^`\n]*`/g, '')
    .trim();
}
const control = {
  pause: /^(?:请|先|麻烦|please\s+)?(?:暂停|暂缓|pause\b|hold\b)/i,
  continue: /^(?:请|现在|麻烦|please\s+)?(?:继续|恢复|resume\b|continue\b)/i,
  stop: /^(?:请|立刻|麻烦|please\s+)?(?:停止|终止|取消|stop\b|cancel\b)/i,
};
const controlQuestion =
  /[?？]|还是|或|哪个|哪项|哪一个|是否|要不要|能否|可否|怎么|如何|\b(?:or|which|whether|how|should|can)\b|[吗么]\s*[。.!！]?$/i;
const ambiguousInstruction =
  /^(?:请|麻烦|please\s+)?(?:先别|别|不要).*(?:这个|那个|这项|那项|this\s+one|that\s+one)/i;
const independentInstruction =
  /^(?:另外|另一个任务|独立任务|新任务|新增任务|new\s+task\b|independent\s+task\b)/i;
function ambiguousControlInquiry(instruction: string, candidates: readonly HumanWorkCandidate[]) {
  if (
    /^(?:另外|另一个任务|独立任务|新任务|新增任务|new\s+task\b|independent\s+task\b)\s*[：:，,]?\s*(?:请\s*|please\s+)?(?:分析|评估|比较|analy[sz]e\b|evaluate\b|compare\b)/i.test(
      instruction,
    )
  )
    return false;
  return instruction.split(/(?<=[。！？?；;\n])|\.(?=\s|$)/).some((clause) => {
    if (
      !controlQuestion.test(clause) ||
      !/(?:停掉|停止|终止|暂停|取消|继续|恢复|停|\b(?:stop|cancel|pause|resume|continue|hold)\b)/i.test(
        clause,
      )
    )
      return false;
    const unclearScope =
      /(?:停掉|停止|终止|暂停|取消|继续|恢复|停|\b(?:stop|cancel|pause|resume|continue|hold)\b)\s*(?:这个|那个|这项|那项|其中|哪个|哪项|哪一个|一个|一项|\b(?:it|this|that|one|either|which)\b)/i.test(
        clause,
      ) || /^\s*(?:请问\s*)?(?:哪个|哪项|哪一个|which\b)/i.test(clause);
    return (
      unclearScope ||
      (namedWorks(clause, candidates).length > 1 &&
        /还是|或|哪个|哪项|哪一个|\b(?:or|which)\b/i.test(clause))
    );
  });
}
function negatesControl(instruction: string, pattern: RegExp): boolean {
  return instruction.split(/[，,。；;\n]|\.\s+/).some((clause) => {
    const text = clause.trim();
    const negation =
      /^(?:不要|别|勿|我(?:并)?不是(?:要求|要|让)?|do\s+not\s+|don't\s+|i\s+(?:am\s+)?not\s+(?:asking|requesting)\s+(?:you\s+)?(?:to\s+)?)/i.exec(
        text,
      );
    return !!negation && pattern.test(text.slice(negation[0].length));
  });
}
function strippedBareControl(content: string, instruction: string): boolean {
  if (!/^(?:继续|resume|continue)\s*[。.!！]?$/i.test(instruction)) return false;
  const original = content
    .split(/[。；;\n]|\.\s+/)
    .map((clause) => clause.trim())
    .find((clause) => Object.values(control).some((pattern) => pattern.test(clause)));
  return original !== undefined && currentHumanInstruction(original) !== original;
}
/** A current alias may restate only the exact identity of its proved scope. */
function currentWorkOperand(operand: string, expectedWorkCommandId?: string): boolean {
  const alias =
    /^(?:当前(?:任务|工作)?|这项任务|本任务|同一(?:个)?(?:原)?任务|(?:the\s+)?(?:same|current)\s+(?:original\s+)?(?:task|work)\b)/i.exec(
      operand,
    );
  if (!alias) return false;
  let suffix = operand.slice(alias[0].length).trim();
  if (expectedWorkCommandId) {
    const escaped = expectedWorkCommandId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const identity = new RegExp(`^${escaped}(?=$|[^A-Za-z0-9_.-]|\\.(?:\\s|$))`).exec(suffix);
    if (identity) suffix = suffix.slice(identity[0].length).trim();
  }
  return /^(?:[。.!！]?\s*$|and\s+(?:use|summari[sz]e|report|keep|preserve|read|write|review|finish|collect|check|verify)\b|[,，]?\s*并(?:且)?\s*(?:汇总|整理|处理|报告|读取|写入|核对|保留|使用|复核|完成))/i.test(
    suffix,
  );
}

function controlInstruction(
  instruction: string,
  candidates: readonly HumanWorkCandidate[],
): { content: string; confirmedTarget: string | null } | null {
  const leading = Object.values(control).find((pattern) => pattern.test(instruction));
  if (leading) {
    if (negatesControl(instruction, leading)) return null;
    const clauses = instruction
      .split(/[。；;\n]|\.\s+/)
      .map((clause) => clause.trim())
      .filter(Boolean);
    const first = clauses[0]!;
    const firstNames = namedWorks(first, candidates);
    const controlWord =
      /(?:停掉|停止|终止|暂停|取消|继续|恢复|停|\b(?:stop|cancel|pause|resume|continue|hold)\b)/i;
    const controlCount = (clause: string) => {
      const text = candidates.reduce(
        (value, candidate) => value.replaceAll(candidate.rootWorkCommandId, ''),
        clause,
      );
      return [...text.matchAll(new RegExp(controlWord.source, 'gi'))].length;
    };
    if (controlCount(first) !== 1) return null;
    const negative =
      /^(?:不要|别|勿|我(?:并)?不是(?:要求|要|让)?|do\s+not\s+|don't\s+|i\s+(?:am\s+)?not\s+(?:asking|requesting)\s+(?:you\s+)?(?:to\s+)?)/i;
    for (const clause of clauses.slice(1)) {
      // An alternative can name a different/unknown target without repeating
      // the control verb. It is still a scope question, never business detail.
      if (/^(?:or\b|或者|还是|或)/i.test(clause)) return null;
      if (!controlWord.test(clause)) continue;
      if (controlCount(clause) > 1) return null;
      if (negative.test(clause)) continue;
      if (!leading.test(clause) || controlQuestion.test(clause)) return null;
      const laterNames = namedWorks(clause, candidates);
      if (laterNames.length) {
        if (
          firstNames.length !== 1 ||
          laterNames.length !== 1 ||
          laterNames[0]!.rootWorkCommandId !== firstNames[0]!.rootWorkCommandId
        )
          return null;
        const command = leading.exec(clause)!;
        const operand = clause.slice(command[0].length).trim();
        const escaped = laterNames[0]!.rootWorkCommandId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (
          !new RegExp(`^${escaped}(?=$|[^A-Za-z0-9_.-]|\\.(?:\\s|$))`).test(
            operand.replace(/^(?:the\s+)?(?:original|same|current)\s+/i, ''),
          ) &&
          !currentWorkOperand(operand, firstNames[0]!.rootWorkCommandId)
        )
          return null;
      } else {
        if (firstNames.length !== 1) return null;
        const command = leading.exec(clause)!;
        const operand = clause.slice(command[0].length).trim();
        if (!currentWorkOperand(operand)) return null;
      }
    }
    return { content: first, confirmedTarget: null };
  }
  const clauses = instruction
    .split(/[。；;\n]|\.\s+/)
    .map((clause) => clause.trim())
    .filter(Boolean);
  const confirmation =
    /^(?:(?:更正|澄清)[：:]\s*)?(?:我指的是\s*|指的是\s*|就是\s*|i\s+mean\s+|to\s+clarify,?\s+)(.+)$/i.exec(
      clauses[0] ?? '',
    );
  const confirmedTarget = candidates.find(
    (candidate) => candidate.rootWorkCommandId === confirmation?.[1]?.trim(),
  )?.rootWorkCommandId;
  // The exact confirmation must immediately precede its control. Reuse the
  // leading-control guard for its entire remaining scope, including alternatives,
  // unknown later targets and mixed controls that are not at a clause start.
  if (!confirmedTarget || !Object.values(control).some((pattern) => pattern.test(clauses[1] ?? '')))
    return null;
  const scoped = controlInstruction(clauses.slice(1).join('\n'), candidates);
  return scoped ? { content: scoped.content, confirmedTarget } : null;
}
export function explicitHumanConfirmationTarget(
  content: string,
  candidates: readonly HumanWorkCandidate[],
): string | null {
  return controlInstruction(currentHumanInstruction(content), candidates)?.confirmedTarget ?? null;
}
function namedWorks(instruction: string, candidates: readonly HumanWorkCandidate[]) {
  return candidates.filter((candidate) => {
    const escaped = candidate.rootWorkCommandId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^A-Za-z0-9_.-])${escaped}(?=$|[^A-Za-z0-9_.-]|\\.(?:\\s|$))`).test(
      instruction,
    );
  });
}
/** A model proposal cannot choose one destructive-control target from ambiguous text. */
function controlTarget(
  instruction: string,
  candidates: readonly HumanWorkCandidate[],
  selectedWork: HumanWorkIdentity | null,
): string | null {
  if (controlQuestion.test(instruction) || ambiguousInstruction.test(instruction)) return null;
  const named = namedWorks(instruction, candidates);
  if (named.length > 1) return null;
  const command = Object.values(control)
    .map((pattern) => pattern.exec(instruction))
    .find(Boolean);
  if (!command) return null;
  const operand = instruction.slice(command[0].length).trim();
  const immediateTarget = candidates.find((candidate) => {
    const escaped = candidate.rootWorkCommandId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${escaped}(?=$|[^A-Za-z0-9_.-]|\\.(?:\\s|$))`).test(
      operand.replace(/^(?:the\s+)?(?:original|same|current)\s+/i, ''),
    );
  });
  const current =
    currentWorkOperand(operand, selectedWork?.rootWorkCommandId) ||
    /^(?:继续|resume|continue)\s*[。.!！]?$/i.test(instruction);
  if (immediateTarget) {
    if (
      /^(?:the\s+)?current\s+/i.test(operand) &&
      selectedWork?.rootWorkCommandId !== immediateTarget.rootWorkCommandId
    )
      return null;
    return immediateTarget.rootWorkCommandId;
  }
  if (
    current &&
    named.length === 1 &&
    selectedWork?.rootWorkCommandId !== named[0]!.rootWorkCommandId
  ) {
    return null;
  }
  return current ? (selectedWork?.rootWorkCommandId ?? null) : null;
}

/** Recognize only explicit local semantics. Everything else remains a bounded proposal. */
export function directHumanInputProposal(input: {
  content: string;
  kind: 'run.start' | 'input.steer' | 'input.follow_up';
  selectedWork: HumanWorkIdentity | null;
  candidates: readonly HumanWorkCandidate[];
  hasPendingClarifications?: boolean;
  hasAttachments?: boolean;
}): HumanInputProposal | null {
  const instruction = currentHumanInstruction(input.content);
  const basis = { kind: 'explicit_text' as const, instruction: input.content };
  if (
    !input.content.trim() &&
    input.hasAttachments &&
    !input.selectedWork &&
    !input.hasPendingClarifications
  )
    return {
      relation: 'independent_work',
      purpose: 'work',
      targetRootWorkCommandId: null,
      selectionEffect: 'select_work',
      basis,
    };
  if (
    !instruction ||
    ambiguousInstruction.test(instruction) ||
    ambiguousControlInquiry(instruction, input.candidates)
  )
    return null;
  const named = namedWorks(instruction, input.candidates);
  const currentControl = controlInstruction(instruction, input.candidates);
  if (named.length > 1 && !currentControl) return null;
  const target = named[0] ?? input.selectedWork;
  for (const purpose of ['pause', 'continue', 'stop'] as const) {
    if (!currentControl || !control[purpose].test(currentControl.content)) continue;
    if (
      controlQuestion.test(currentControl.content) ||
      strippedBareControl(input.content, currentControl.content)
    )
      return null;
    const targetRootWorkCommandId = controlTarget(
      currentControl.content,
      input.candidates,
      input.selectedWork,
    );
    if (
      !targetRootWorkCommandId ||
      (currentControl.confirmedTarget && currentControl.confirmedTarget !== targetRootWorkCommandId)
    )
      return null;
    return {
      relation: 'same_work',
      purpose,
      targetRootWorkCommandId,
      selectionEffect: purpose === 'continue' ? 'select_work' : 'keep',
      basis,
    };
  }
  if (
    /^(?:请问|现在|目前|请|what(?:'s| is)?\s+|how(?:'s| is)?\s+)?(?:进度|状态|情况|progress\b|status\b)/i.test(
      instruction,
    ) ||
    /^(?:做得怎么样|进行得怎么样|怎么样了|how.*(?:going|progress)|what.*progress)/i.test(
      instruction,
    )
  ) {
    if (!target) return null;
    return {
      relation: 'same_work',
      purpose: 'progress',
      targetRootWorkCommandId: target.rootWorkCommandId,
      selectionEffect: 'keep',
      basis,
    };
  }
  if (independentInstruction.test(instruction))
    return {
      relation: 'independent_work',
      purpose: 'work',
      targetRootWorkCommandId: null,
      selectionEffect: 'select_work',
      basis,
    };
  if (/^(?:补充|追加|仍然|仍需|再核对|follow[ -]?up\b|steer\b)/i.test(instruction) && target)
    return {
      relation: 'same_work',
      purpose: 'work',
      targetRootWorkCommandId: target.rootWorkCommandId,
      selectionEffect: 'keep',
      basis,
    };
  if (
    !input.selectedWork &&
    !input.hasPendingClarifications &&
    instruction === input.content.trim()
  )
    return {
      relation: 'independent_work',
      purpose: 'work',
      targetRootWorkCommandId: null,
      selectionEffect: 'select_work',
      basis,
    };
  return null;
}

/** The model can explain a real input, but cannot manufacture an unexpressed control. */
export function validateHumanInputProposal(
  proposal: HumanInputProposal,
  content: string,
  candidates: readonly HumanWorkCandidate[],
  selectedWork: HumanWorkIdentity | null = null,
  hasAttachments = false,
): HumanInputProposal {
  const instruction = currentHumanInstruction(content);
  const unresolved = (): HumanInputProposal => ({
    relation: 'unresolved',
    purpose: 'clarify',
    targetRootWorkCommandId: null,
    selectionEffect: 'keep',
    basis: { kind: 'model_proposal', instruction: content },
  });
  if (
    (!instruction && !(hasAttachments && !content.trim() && proposal.purpose === 'work')) ||
    ambiguousInstruction.test(instruction) ||
    ambiguousControlInquiry(instruction, candidates) ||
    proposal.basis.instruction !== content
  )
    return unresolved();
  if (
    proposal.targetRootWorkCommandId !== null &&
    !candidates.some(
      (candidate) => candidate.rootWorkCommandId === proposal.targetRootWorkCommandId,
    )
  )
    return unresolved();
  if (proposal.relation === 'same_work' && proposal.purpose === 'progress') {
    const questions = instruction
      .split(/(?<=[。！？?；;\n])|\.(?=\s|$)/)
      .filter(
        (clause) =>
          /进度|状态|情况|发现|进展|progress|status|findings/i.test(clause) &&
          /[？?]|请问|怎么样|如何|哪些|什么|告诉我|汇报|\b(?:what|how|report|tell\s+me|show\s+me)\b/i.test(
            clause,
          ),
      );
    if (questions.length === 1) {
      const named = namedWorks(questions[0]!, candidates);
      if (named.length === 1 && named[0]!.rootWorkCommandId !== proposal.targetRootWorkCommandId)
        return unresolved();
    }
  }
  if (
    proposal.purpose === 'pause' ||
    proposal.purpose === 'continue' ||
    proposal.purpose === 'stop'
  ) {
    const currentControl = controlInstruction(instruction, candidates);
    if (
      !currentControl ||
      controlQuestion.test(currentControl.content) ||
      strippedBareControl(content, currentControl.content) ||
      !control[proposal.purpose].test(currentControl.content) ||
      controlTarget(currentControl.content, candidates, selectedWork) !==
        proposal.targetRootWorkCommandId ||
      (currentControl.confirmedTarget !== null &&
        currentControl.confirmedTarget !== proposal.targetRootWorkCommandId)
    )
      return unresolved();
  }
  if (
    proposal.purpose === 'replace' &&
    !/(?:替换|改做|改为|instead\b|replace\b)/i.test(instruction)
  )
    return unresolved();
  return proposal;
}
