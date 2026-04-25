const rawPerf = String(process.env.PERF_LOG || '').trim().toLowerCase();
export const PERF_LOG_ENABLED = ['1', 'true', 'yes', 'on'].includes(rawPerf);

function formatDetailValue(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  if (value === null || value === undefined) return '';
  return String(value);
}

export function perfLog(scope, message, details = null) {
  if (!PERF_LOG_ENABLED) return;
  if (!details || typeof details !== 'object') {
    console.log(`[perf:${scope}] ${message}`);
    return;
  }
  const extra = Object.entries(details)
    .map(([key, val]) => `${key}=${formatDetailValue(val)}`)
    .join(' ');
  console.log(`[perf:${scope}] ${message}${extra ? ` ${extra}` : ''}`);
}

export function readMemoryUsageMb() {
  const m = process.memoryUsage();
  const toMb = (n) => Number((Number(n || 0) / 1024 / 1024).toFixed(1));
  return {
    rssMb: toMb(m.rss),
    heapUsedMb: toMb(m.heapUsed),
    heapTotalMb: toMb(m.heapTotal),
    externalMb: toMb(m.external)
  };
}
