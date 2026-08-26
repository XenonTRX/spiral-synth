// One Fourier transform, for everything that needs one.
//
// This lived inside analysis.js, which was the right place while measuring was the only thing that
// wanted it. Wavetable generation wants it too, and wants it from the other direction: a table is
// built by naming the harmonics it should contain and transforming *back* into samples, which is
// the only way to get a waveform that is band-limited by construction rather than by correction.
//
// Moved rather than copied, because two FFTs in one project is two chances to have a subtly wrong
// one and no way to notice - the failure mode of a bad transform is a spectrum that looks
// plausible. It has no imports, which also means it loads inside AudioWorkletGlobalScope and in
// Node without dragging anything behind it.

/**
 * An in-place iterative radix-2 FFT over separate real and imaginary arrays.
 *
 * Written out rather than pulled in because the project has no build step and no dependencies,
 * and this is sixty lines of arithmetic that has not changed since 1965.
 *
 * `re.length` must be a power of two, and `im` must be the same length.
 */
export function fft(re, im) {
  const n = re.length;

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const xr = re[i + k + half];
        const xi = im[i + k + half];
        const vr = xr * cr - xi * ci;
        const vi = xr * ci + xi * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + half] = ur - vr;
        im[i + k + half] = ui - vi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/**
 * The inverse, in place, by the conjugate trick: conjugating the input, running the forward
 * transform, and conjugating and scaling the result is the inverse transform.
 *
 * Worth doing this way rather than writing a second loop with the sign of the twiddle flipped.
 * The two would be ninety-five percent identical, and the five percent is exactly where a sign
 * error would live - one that produces a waveform that is time-reversed, or off by a scale
 * factor, and in both cases still looks like a plausible wave.
 */
export function ifft(re, im) {
  const n = re.length;
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fft(re, im);
  const scale = 1 / n;
  for (let i = 0; i < n; i++) {
    re[i] *= scale;
    im[i] *= -scale;
  }
}
