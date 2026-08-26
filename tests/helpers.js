// Small shared rig for driving a block-based processor from a test.

/** Run mono `signal` through a processor in `block`-sized chunks and collect the output. */
export function runMono(proc, signal, block = 128) {
  const out = new Float32Array(signal.length);
  const inBuf = [new Float32Array(block)];
  const outBuf = [new Float32Array(block)];
  for (let i = 0; i < signal.length; i += block) {
    const n = Math.min(block, signal.length - i);
    inBuf[0].fill(0);
    inBuf[0].set(signal.subarray(i, i + n));
    proc.process(inBuf, outBuf, n);
    out.set(outBuf[0].subarray(0, n), i);
  }
  return out;
}

export const peak = (a) => a.reduce((m, x) => Math.max(m, Math.abs(x)), 0);

export function sine(freq, sampleRate, seconds, amp = 1) {
  const n = Math.round(sampleRate * seconds);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return a;
}

export function square(freq, sampleRate, seconds, amp = 1) {
  const n = Math.round(sampleRate * seconds);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = amp * (Math.sin((2 * Math.PI * freq * i) / sampleRate) >= 0 ? 1 : -1);
  return a;
}

export const dbOver = (value, ceiling) => 20 * Math.log10(value / ceiling);
