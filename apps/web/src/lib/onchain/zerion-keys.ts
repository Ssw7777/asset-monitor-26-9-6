/**
 * Zerion 额度以接口返回的组织级 ratelimit-org-* 为准。
 * 同一组织的多把 Key 不增加组织额度；轮转仅用于兼容现有配置，
 * 不能据此推算总额度，也不能绕过组织限流。
 */

let rotation = 0;

export function zerionKeys(): string[] {
  const primary = (process.env.ZERION_API_KEY || "").trim();
  const extra = (process.env.ZERION_API_KEYS || "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
  const keys = extra.includes(primary) ? extra : [...extra, primary].filter(Boolean);
  return keys;
}

/** 轮转取下一把 Key；没有配置任何 Key 时返回 null。 */
export function nextZerionKey(): string | null {
  const keys = zerionKeys();
  if (!keys.length) return null;
  const key = keys[rotation % keys.length];
  rotation += 1;
  return key;
}

/**
 * 单实例请求串行 + 相邻间隔 1100ms，兼容当前 1 RPS 的额度。
 * 此队列不跨 Serverless 实例；组织级限流仍由服务商统一执行。
 */
let zerionQueue: Promise<void> = Promise.resolve();

export function zerionRequest<T>(fn: () => Promise<T>): Promise<T> {
  const run = zerionQueue.then(fn, fn);
  zerionQueue = run
    .catch(() => undefined)
    .then(() => new Promise<void>((resolve) => setTimeout(resolve, 1100)));
  return run;
}
