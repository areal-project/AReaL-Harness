// Goal and TaskRun share Core's accounting ledger. Render its fields directly;
// a missing field or incomplete ledger never becomes an invented zero total.
export type GoalUsage = {
  inputTokens?: number; outputTokens?: number; cachedInputTokens?: number;
  tokensUsed: number; reservedTokens: number; unknownRequests: number;
  timeUsedSeconds: number; turnsStarted: number; accountingComplete: boolean;
};

export function GoalUsageSummary({ usage, label }: { usage: GoalUsage; label: string }) {
  return <section aria-label={label} className="grid gap-1 text-foreground-subtle text-ui-sm">
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
      {([['输入 Token', 'inputTokens'], ['缓存输入', 'cachedInputTokens'], ['输出 Token', 'outputTokens'], ['已确认 Token', 'tokensUsed'], ['预留 Token', 'reservedTokens'], ['未知请求', 'unknownRequests']] as const).map(([name, field]) => <div key={field} className="flex justify-between gap-2"><dt>{name}</dt><dd data-usage-field={field}>{usage[field] == null ? '未知' : usage[field].toLocaleString()}</dd></div>)}
    </dl>
    {(!usage.accountingComplete || usage.unknownRequests > 0) && <p role="status">消费尚未确认；以上为已确认用量，预留不等于实际消费。</p>}
  </section>;
}
