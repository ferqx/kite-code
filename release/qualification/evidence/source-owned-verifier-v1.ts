/**
 * AQ-1's source-owned suite checks inventory integrity only. This registry is
 * deliberately closed to reviewed diagnostic suites; it is not a
 * release-control registry and cannot grant release authority.
 */
export const QUALIFICATION_SUITE_ROLE_REGISTRY_V1 = [
  {
    suiteId: 'source-owned-surface-contract-v1',
    role: 'structural_inventory',
  },
  {
    suiteId: 'qualification-l0-contract-v1',
    role: 'behavioral',
  },
  {
    suiteId: 'qualification-l1-tool-verification-v1',
    role: 'behavioral',
  },
  {
    suiteId: 'qualification-l1-auto-compaction-failure-v1',
    role: 'behavioral',
  },
  {
    suiteId: 'qualification-l1-public-projection-v1',
    role: 'behavioral',
  },
  {
    suiteId: 'qualification-l1-skill-mcp-v1',
    role: 'behavioral',
  },
  {
    suiteId: 'qualification-l1-subagent-recovery-v1',
    role: 'behavioral',
  },
  {
    suiteId: 'qualification-l1-tui-rewind-fork-projection-v1',
    role: 'behavioral',
  },
  {
    suiteId: 'qualification-l2-native-conformance-v1',
    role: 'behavioral',
  },
  {
    suiteId: 'qualification-l3-live-compatibility-v1',
    role: 'behavioral',
  },
  {
    suiteId: 'qualification-l3-live-auto-compaction-v1',
    role: 'behavioral',
  },
] as const;

export {
  isRegisteredQualificationLocalSyntheticExecutionV1,
  QUALIFICATION_LOCAL_SYNTHETIC_EXECUTION_REGISTRY_V1,
} from './source-owned-execution-registry-v1';

export type RegisteredQualificationSuiteRoleV1 =
  (typeof QUALIFICATION_SUITE_ROLE_REGISTRY_V1)[number]['role'];

export function registeredQualificationSuiteRoleV1(
  suiteId: string,
): RegisteredQualificationSuiteRoleV1 | undefined {
  return QUALIFICATION_SUITE_ROLE_REGISTRY_V1.find((entry) => entry.suiteId === suiteId)?.role;
}
