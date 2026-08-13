import type { AgentPhase, SubAgentRole } from '@/protocol/events';

export type DelegationAdmissionReasonV1 =
  | 'admitted'
  | 'user_delegation_not_requested'
  | 'task_not_bounded'
  | 'planning_role_invalid'
  | 'plan_role_requires_architecture_or_design'
  | 'delegation_explicitly_denied'
  | 'delegation_role_mismatch';

export interface DelegationAdmissionV1 {
  allowed: boolean;
  reason: DelegationAdmissionReasonV1;
}

const EXPLICIT_DELEGATION_PATTERN =
  /\b(?:delegate|delegation|sub[- ]?agents?|parallel agents?|multiple agents?|spawn an agent)\b|(?:委派|子代理|子\s*agent|多代理|并行代理)/iu;
const ARCHITECTURE_OR_DESIGN_PATTERN =
  /\b(?:architecture|architectural|design)\b|(?:架构|设计|方案)/iu;
const DELEGATION_DENY_PATTERN =
  /\b(?:do\s+not|don't|dont|never|avoid)\b.{0,40}\b(?:delegate|delegation|sub[- ]?agent|agents?|spawn)\b|\bwithout\s+(?:using\s+)?(?:delegat(?:e|ing|ion)|sub[- ]?agents?|spawning\s+agents?)\b|(?:不要|请勿|勿|禁止|避免).{0,20}(?:委派|子代理|子\s*agent|多代理|并行代理)/iu;

const ALL_SUBAGENT_ROLES: readonly SubAgentRole[] = ['explore', 'plan', 'code', 'review'];
const ALL_ROLE_TEST_PATTERN =
  /\b(?:test|verify|smoke[- ]?test)\b.{0,40}\b(?:all|every)\b.{0,20}\b(?:sub[- ]?agents?|agent roles?)\b|(?:测试|验证|冒烟).{0,20}(?:所有|全部|每个).{0,12}(?:子代理|子\s*agent|代理角色)/iu;
const ROLE_TEST_PATTERN =
  /\b(?:test|verify|smoke[- ]?test)\b.{0,40}\b(?:sub[- ]?agents?|agent roles?)\b|(?:测试|验证|冒烟).{0,24}(?:子代理|子\s*agent|代理角色)/iu;

function explicitlyRequestedRoles(goal: string): ReadonlySet<SubAgentRole> {
  if (ALL_ROLE_TEST_PATTERN.test(goal)) return new Set(ALL_SUBAGENT_ROLES);
  const roles = new Set<SubAgentRole>();
  const roleTest = ROLE_TEST_PATTERN.test(goal);
  if (
    /\bcode\s+(?:sub[- ]?agent|agent)\b|(?:代码|实现)(?:子代理|代理)/iu.test(goal) ||
    (roleTest && /\bcode\b|代码/iu.test(goal))
  ) {
    roles.add('code');
  }
  if (
    /\breview\s+(?:sub[- ]?agent|agent)\b|(?:审查|复审)(?:子代理|代理)/iu.test(goal) ||
    (roleTest && /\breview\b|审查|复审/iu.test(goal))
  ) {
    roles.add('review');
  }
  if (
    /\bplan\s+(?:sub[- ]?agent|agent)\b|(?:规划|方案)(?:子代理|代理)/iu.test(goal) ||
    (roleTest && /\bplan\b|规划|方案/iu.test(goal))
  ) {
    roles.add('plan');
  }
  if (
    /\bexplor(?:e|ation)\s+(?:sub[- ]?agent|agent)\b|(?:探索|调研)(?:子代理|代理)/iu.test(goal) ||
    (roleTest && /\bexplor(?:e|ation)\b|探索|调研/iu.test(goal))
  ) {
    roles.add('explore');
  }
  return roles;
}

/** Role smoke tests prove dispatch only; they never imply mutation authority. */
export function isDelegationRoleSmokeTestV1(goal: string, role: SubAgentRole): boolean {
  return ROLE_TEST_PATTERN.test(goal) && explicitlyRequestedRoles(goal).has(role);
}

function hasPositiveRoleScope(goal: string, role: SubAgentRole): boolean {
  if (
    role === 'code' &&
    (/\b(?:do\s+not|don't|dont|without|avoid)\b.{0,30}\b(?:write|edit|modify|change|implement)\b|\bread[- ]only\b|\b(?:review|audit|inspect|design|plan|options?)\b|(?:不要|请勿|禁止|避免|无需).{0,20}(?:写|编辑|修改|实现)|(?:只读|审查|复审|检查|设计|规划|方案|选项)/iu.test(
      goal,
    ) ||
      !/\b(?:implement|implementation|edit|modify|change|fix|build|write)\b|(?:实施|实现|编码|修改|修复|构建|编写)/iu.test(
        goal,
      ))
  ) {
    return false;
  }
  const scope =
    role === 'code'
      ? /\b(?:implement|implementation|edit|modify|change|fix|build|write)\b|(?:实施|实现|编码|修改|修复|构建|编写)/iu
      : role === 'review'
        ? /\b(?:review|audit|critique|inspect|inspections?)\b|(?:审查|复审|评审|审核|检查)/iu
        : role === 'plan'
          ? /\b(?:architecture|architectural|design|inspect|inspections?)\b|(?:架构|设计|方案|检查)/iu
          : /\b(?:explore|exploration|inspect|inspections?|investigate|research|search|trace)\b|(?:探索|调研|检索|搜索|调查|查阅|检查)/iu;
  return scope.test(goal);
}

/** Only the current user-authored task goal is accepted by this gate. */
export function admitDelegationV1(input: {
  userGoal: string;
  delegatedTask: string;
  role: SubAgentRole;
  phase: AgentPhase;
}): DelegationAdmissionV1 {
  if (DELEGATION_DENY_PATTERN.test(input.userGoal)) {
    return { allowed: false, reason: 'delegation_explicitly_denied' };
  }
  if (!EXPLICIT_DELEGATION_PATTERN.test(input.userGoal)) {
    return { allowed: false, reason: 'user_delegation_not_requested' };
  }
  const task = input.delegatedTask.trim();
  const latinTaskTooVague =
    !/[^\p{ASCII}]/u.test(task) && task.split(/\s+/u).filter(Boolean).length < 3;
  if (
    task.length < 8 ||
    task.length > 8_000 ||
    latinTaskTooVague ||
    /\b(?:as above|the above|previous conversation|earlier context|same as before)\b|(?:如上|以上内容|前文|之前对话|同上)/iu.test(
      task,
    )
  ) {
    return { allowed: false, reason: 'task_not_bounded' };
  }
  if (input.phase === 'planning' && input.role !== 'explore' && input.role !== 'plan') {
    return { allowed: false, reason: 'planning_role_invalid' };
  }
  const requestedRoles = explicitlyRequestedRoles(input.userGoal);
  if (requestedRoles.size > 0 && !requestedRoles.has(input.role)) {
    return { allowed: false, reason: 'delegation_role_mismatch' };
  }
  const explicitRoleTest = isDelegationRoleSmokeTestV1(input.userGoal, input.role);
  if (!explicitRoleTest && !hasPositiveRoleScope(input.userGoal, input.role)) {
    return {
      allowed: false,
      reason:
        input.phase === 'planning' && input.role === 'plan'
          ? 'plan_role_requires_architecture_or_design'
          : 'delegation_role_mismatch',
    };
  }
  if (
    input.phase === 'planning' &&
    input.role === 'plan' &&
    !explicitRoleTest &&
    !ARCHITECTURE_OR_DESIGN_PATTERN.test(input.userGoal)
  ) {
    return { allowed: false, reason: 'plan_role_requires_architecture_or_design' };
  }
  return { allowed: true, reason: 'admitted' };
}

export function planningContinuationAfterPlanSubagentV1(input: {
  phase: AgentPhase;
  role: SubAgentRole;
  childTerminal: boolean;
  childOk?: boolean;
  childStatus?: 'completed' | 'failed' | 'cancelled' | 'exhausted' | 'suspended';
}): readonly ['write_plan:save', 'write_plan:submit'] | readonly [] {
  return input.phase === 'planning' &&
    input.role === 'plan' &&
    input.childTerminal &&
    input.childOk !== false &&
    (input.childStatus === undefined || input.childStatus === 'completed')
    ? (['write_plan:save', 'write_plan:submit'] as const)
    : [];
}
