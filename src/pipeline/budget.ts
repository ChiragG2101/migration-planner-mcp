// The run budget (M9 task 5): wall time and reported tokens per run, from
// --budget-seconds and --budget-tokens. Time runs from the run's first event;
// tokens are what the host reported (cost.reported events). Once a run is
// over budget, the lenses and stages it has not started are recorded as
// budget_cut and refused, so nothing is skipped silently: their usages stay
// uncovered for gate 2, and the run report lists every cut.
export interface Budget {
  tokens?: number;
  seconds?: number;
}

export interface BudgetUse {
  seconds: number;
  tokens: number;
}

export interface BudgetEvent {
  ts: string;
  kind: string;
  payload_json: string;
  tokens_in: number | null;
  tokens_out: number | null;
}

export interface BudgetCut {
  /** A lens that was never fetched, or a stage that was never settled. */
  what: 'lens' | 'stage';
  id: string;
  reason: string;
}

export function budgetUse(events: readonly BudgetEvent[], now: Date): BudgetUse {
  const first = events[0];
  const seconds = first ? Math.max(0, (now.getTime() - Date.parse(first.ts)) / 1000) : 0;
  const tokens = events.reduce((n, e) => n + (e.tokens_in ?? 0) + (e.tokens_out ?? 0), 0);
  return { seconds, tokens };
}

/** Why the run is over budget, or null when it is within it (or has none). */
export function overBudget(budget: Budget | undefined, use: BudgetUse): string | null {
  if (budget?.tokens !== undefined && use.tokens > budget.tokens) return `tokens ${use.tokens} over the budget of ${budget.tokens}`;
  if (budget?.seconds !== undefined && use.seconds > budget.seconds) return `${Math.round(use.seconds)} s over the budget of ${budget.seconds} s`;
  return null;
}

/** Cuts already recorded for the run, so each lens or stage is cut once. */
export function recordedCuts(events: readonly BudgetEvent[]): BudgetCut[] {
  return events.filter((e) => e.kind === 'budget.cut').map((e) => JSON.parse(e.payload_json) as BudgetCut);
}

/**
 * The new cuts for a run over budget: every remaining item not cut already.
 * Empty when the run is within budget.
 */
export function newCuts(budget: Budget | undefined, events: readonly BudgetEvent[], now: Date, remaining: readonly { what: BudgetCut['what']; id: string }[]): { reason: string | null; cuts: BudgetCut[] } {
  const reason = overBudget(budget, budgetUse(events, now));
  if (!reason) return { reason: null, cuts: [] };
  const done = new Set(recordedCuts(events).map((c) => `${c.what}:${c.id}`));
  return { reason, cuts: remaining.filter((r) => !done.has(`${r.what}:${r.id}`)).map((r) => ({ ...r, reason })) };
}
