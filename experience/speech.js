/* ==========================================================================
   A SENTENCE, AS A LEVEL SIGNAL.

   The waveform's whole contract is that a flat row means silence — so a
   decorative wobble would be worse than nothing. There is no microphone here,
   so the envelope is generated FROM THE TEXT: each word gets a duration from
   its syllables, an attack and a decay, and the gaps between words and after
   punctuation are genuinely silent. The result is a signal that rises and
   falls with the sentence actually being typed.

   The numbers it produces are in the engine's own units — the range
   LevelMeter is calibrated against, min(1, rms × 4), where ordinary speech
   lands around 0.08–0.16 — so the same gate, ceiling, curve and envelope run
   over it unchanged.
   ========================================================================== */

/** Rough syllable count. Wrong sometimes; right often enough to set a rhythm. */
function syllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 1;
  const groups = w.match(/[aeiouy]+/g);
  let n = groups ? groups.length : 1;
  if (w.endsWith("e") && n > 1) n -= 1;          // silent e
  return Math.max(1, n);
}

/** Speaking rate: about 165 words a minute, so ~180ms per syllable. */
const MS_PER_SYLLABLE = 180;
const GAP_MS = 55;          // between words
const COMMA_MS = 220;       // a breath
const PERIOD_MS = 420;      // a full stop

/**
 * Turn a sentence into a schedule.
 * Returns { totalMs, words: [{ text, startMs, endMs }], levelAt(ms) }.
 */
export function speak(text) {
  const tokens = text.split(/\s+/).filter(Boolean);
  const words = [];
  let t = 0;
  for (const token of tokens) {
    const dur = syllables(token) * MS_PER_SYLLABLE;
    words.push({ text: token, startMs: t, endMs: t + dur });
    t += dur + GAP_MS;
    if (/[,;:]$/.test(token)) t += COMMA_MS;
    if (/[.!?]$/.test(token)) t += PERIOD_MS;
  }
  const totalMs = t;

  /** Raw level at a moment — silent between words, shaped within them. */
  function levelAt(ms) {
    for (const w of words) {
      if (ms < w.startMs || ms > w.endMs) continue;
      const p = (ms - w.startMs) / (w.endMs - w.startMs);
      // Attack over the first fifth, decay across the rest: how a syllable
      // actually sounds, rather than a flat block.
      const shell = p < 0.2 ? p / 0.2 : 1 - (p - 0.2) / 0.8 * 0.75;
      // Syllable modulation inside the word, so a long word is not one lump.
      const syl = syllables(w.text);
      const wobble = 0.72 + 0.28 * Math.abs(Math.sin(Math.PI * syl * p));
      // Per-word variation, keyed off the word so it is the same every time.
      const seed = (w.text.charCodeAt(0) * 37 + w.text.length * 11) % 100 / 100;
      const gain = 0.085 + 0.075 * seed;        // lands in speech's real range
      return Math.max(0, shell * wobble * gain);
    }
    return 0;   // between words: genuinely nothing
  }

  return { totalMs, words, levelAt };
}
