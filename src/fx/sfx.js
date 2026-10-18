// SOUND DISABLED (user request 2026-10-17 22:50): the site must make no sound at all.
// This module keeps the createSfx() API that the choreography calls, but every method is a no-op and no
// AudioContext is ever created. The previous synthesized implementation is kept out of the build on purpose
// (head chat scratchpad backup); do not re-enable without the user's go.
export function createSfx() {
  const api = {
    muted: true,
    unlock() {},
    play() {},
    stopMusic() {},
    setMuted() {
      api.muted = true;
    },
  };
  return api;
}
