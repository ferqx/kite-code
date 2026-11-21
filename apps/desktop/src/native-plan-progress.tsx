import { type PlanExecutionOutcome as Outcome, PlanExecutionHistory } from '@kite-ai/ui/desktop';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { NativeBridge, NativeSelection } from './native-bridge';
import type { NativePlanProgress, NativePlanProgressResult } from './native-plan-progress-bridge';

type ReadProgress = (runId: string, history: boolean) => Promise<NativePlanProgressResult['plans']>;
type ActiveRun = { id: string; revision?: string };

export function useNativePlanProgress({
  bridge,
  generation,
  selection,
  historyEpoch,
  available,
  unconfirmed,
  activeRun,
  waitingForReview,
}: {
  bridge?: NativeBridge;
  generation: number;
  selection?: NativeSelection;
  historyEpoch: number;
  available: boolean;
  unconfirmed: boolean;
  activeRun?: ActiveRun;
  waitingForReview: boolean;
}) {
  const storeId = selection?.storeId;
  const sessionId = selection?.session.id;
  const viewSelection = selection?.viewSelection ?? selection?.viewGeneration;
  const scope = sessionId && JSON.stringify([generation, storeId, sessionId]);
  const read = useMemo<ReadProgress | undefined>(() => {
    if (!bridge || !available || !storeId || !sessionId || viewSelection === undefined)
      return undefined;
    return async (runId, history) => {
      const result = await bridge.request({
        method: 'planning.progress',
        generation,
        viewSelection,
        historyEpoch,
        runId,
        history,
      });
      if (
        !result ||
        !('plans' in result) ||
        result.kind !== 'planning.progress' ||
        result.storeId !== storeId ||
        result.sessionId !== sessionId ||
        result.runId !== runId
      )
        throw Error('planning_progress_unavailable');
      return result.plans;
    };
  }, [bridge, available, storeId, sessionId, generation, viewSelection, historyEpoch]);
  const [live, setLive] = useState<{
    scope: string;
    runId: string;
    plan: NativePlanProgress;
    historyEpoch: number;
    stale: boolean;
    outcome?: Outcome;
  }>();
  const [openId, setOpenId] = useState<string>();
  const runId = activeRun?.id;
  const revision = activeRun?.revision;
  useEffect(() => {
    if (!scope || waitingForReview) return;
    if (!read || !runId) return;
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = 500;
    const load = () => {
      void read(runId, false).then(
        ([plan]) => {
          if (disposed) return;
          setLive(plan ? { scope, runId, plan, historyEpoch, stale: false } : undefined);
        },
        () => {
          if (disposed) return;
          setLive((previous) =>
            previous?.scope === scope && previous.runId === runId && !previous.stale
              ? { ...previous, stale: true }
              : previous,
          );
          retry = setTimeout(load, delay);
          delay = Math.min(delay * 2, 4000);
        },
      );
    };
    // A new plan/update result invalidates the earlier read, including approval handoff.
    if (revision !== undefined) load();
    return () => {
      disposed = true;
      clearTimeout(retry);
    };
  }, [scope, read, runId, revision, waitingForReview, historyEpoch]);
  useEffect(() => {
    setLive((previous) =>
      previous && (previous.scope !== scope || waitingForReview) ? undefined : previous,
    );
  }, [scope, waitingForReview]);
  const settle = useCallback(
    (owner: string, plans: readonly NativePlanProgress[], outcome: Outcome) => {
      setLive((previous) => {
        if (!previous || previous.scope !== scope || previous.runId !== owner || previous.outcome)
          return previous;
        const exact = plans.find(
          (plan) =>
            plan.reviewExecutionId === previous.plan.reviewExecutionId &&
            plan.planId === previous.plan.planId &&
            plan.version === previous.plan.version &&
            plan.digest === previous.plan.digest,
        );
        return exact ? { ...previous, plan: exact, stale: false, outcome } : previous;
      });
    },
    [scope],
  );
  const shown =
    live && live.scope === scope && !waitingForReview && (!runId || runId === live.runId)
      ? live
      : undefined;
  const open = !!shown && shown.plan.reviewExecutionId === openId;
  const active =
    shown && (!shown.outcome || open)
      ? {
          ...shown,
          stale:
            !shown.outcome && (shown.stale || unconfirmed || shown.historyEpoch !== historyEpoch),
        }
      : undefined;
  const setOpen = useCallback(
    (next: boolean) => {
      setOpenId(next ? active?.plan.reviewExecutionId : undefined);
    },
    [active?.plan.reviewExecutionId],
  );
  const onEnvironmentVisibilityChange = useCallback((visible: boolean) => {
    if (!visible) setOpenId(undefined);
  }, []);
  return { active, open, setOpen, onEnvironmentVisibilityChange, read, settle };
}

export function NativePlanHistory({
  runId,
  outcome,
  read,
  onReady,
  onLocate,
}: {
  runId: string;
  outcome: Outcome;
  read?: ReadProgress;
  onReady: (runId: string, plans: readonly NativePlanProgress[], outcome: Outcome) => void;
  onLocate: (plan: NativePlanProgress) => void;
}) {
  const [plans, setPlans] = useState<readonly NativePlanProgress[]>();
  useEffect(() => {
    if (!read) return;
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = 500;
    const load = () => {
      void read(runId, true).then(
        (value) => {
          if (disposed) return;
          setPlans(value);
        },
        () => {
          if (disposed) return;
          retry = setTimeout(load, delay);
          delay = Math.min(delay * 2, 4000);
        },
      );
    };
    load();
    return () => {
      disposed = true;
      clearTimeout(retry);
    };
  }, [read, runId]);
  useEffect(() => {
    if (plans?.length) onReady(runId, plans, outcome);
  }, [runId, plans, outcome, onReady]);
  return !!plans?.length && <PlanExecutionHistory plans={plans} onLocate={onLocate} />;
}
