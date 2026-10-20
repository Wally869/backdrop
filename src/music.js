// Background music: one looping track through Web Audio (gapless, unlike <audio loop>). Browsers allow sound only
// after a user gesture, so start() must be called from a click or key handler; the track fades in. Mute is saved.
const VOLUME = 0.35;
const FADE_IN_S = 2.0;
const MUTE_FADE_S = 0.3;
const MUTE_KEY = "backdrop.muted";

export function createMusic(url) {
  const data = fetch(url).then((r) => {
    if (!r.ok) throw new Error(`cannot load ${url}: ${r.status}`);
    return r.arrayBuffer();
  });
  let ctx = null;
  let gain = null;
  let muted = localStorage.getItem(MUTE_KEY) === "1";

  const target = () => (muted ? 0 : VOLUME);
  return {
    get muted() { return muted; },
    get state() { return ctx ? ctx.state : "not started"; },
    // Creates the AudioContext inside the gesture, then decodes and loops the track.
    async start() {
      if (ctx) return;
      ctx = new AudioContext();
      gain = ctx.createGain();
      gain.gain.value = 0;
      gain.connect(ctx.destination);
      const src = ctx.createBufferSource();
      src.buffer = await ctx.decodeAudioData(await data);
      src.loop = true;
      src.connect(gain);
      src.start();
      gain.gain.linearRampToValueAtTime(target(), ctx.currentTime + FADE_IN_S);
    },
    setMuted(m) {
      muted = m;
      localStorage.setItem(MUTE_KEY, m ? "1" : "0");
      if (!gain) return;
      const now = ctx.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(target(), now + MUTE_FADE_S);
    },
  };
}
