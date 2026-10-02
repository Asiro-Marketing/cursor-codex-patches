const MIN_CACHE_MS = 60000;

function createUsageState() {
  return { data: null, updatedAt: 0, error: null, loading: false, backoffUntil: 0, failures: 0 };
}

async function refreshUsageState(state, fetchData, render, force = false) {
  const now = Date.now();
  if (state.loading || now < state.backoffUntil) return;
  if (!force && state.data && now - state.updatedAt < MIN_CACHE_MS) return;
  state.loading = true;
  render();
  try {
    state.data = await fetchData();
    state.updatedAt = Date.now();
    state.error = null;
    state.failures = 0;
    state.backoffUntil = 0;
  } catch (error) {
    if (error.code !== 'cancelled') {
      state.failures = Math.min(state.failures + 1, 5);
      const waitSec = error.code === 429 ? error.waitSec || 900 : Math.min(900, 60 * 2 ** state.failures);
      state.backoffUntil = Date.now() + waitSec * 1000;
      state.error = error.code === 429 ? `レート制限中（約${Math.ceil(waitSec / 60)}分後に再試行）`
        : error.message || '使用量を取得できません';
    }
  } finally {
    state.loading = false;
    render();
  }
}

module.exports = { createUsageState, refreshUsageState };
