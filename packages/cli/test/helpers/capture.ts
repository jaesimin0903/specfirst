/** Runs fn while collecting console.log, console.error and process.stdout writes, ANSI codes stripped. */
export async function capture(fn: () => Promise<unknown>): Promise<{ out: string[]; err: string[]; stdout: string }> {
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const out: string[] = [];
  const err: string[] = [];
  let stdout = '';
  const log = console.log;
  const error = console.error;
  const write = process.stdout.write.bind(process.stdout);
  console.log = (...a: unknown[]) => void out.push(strip(a.map(String).join(' ')));
  console.error = (...a: unknown[]) => void err.push(strip(a.map(String).join(' ')));
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    console.log = log;
    console.error = error;
    process.stdout.write = write;
  }
  return { out, err, stdout };
}
