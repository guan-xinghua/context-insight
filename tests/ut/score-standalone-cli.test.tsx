
describe('scoreMode 入口判定', () => {
  it('无 --session → TUI；--tui 强制 TUI；有 --session → 一次性 CLI', async () => {
    const { scoreMode } = await import('../../src/cli/commands/score');
    expect(scoreMode({})).toBe('tui');
    expect(scoreMode({ session: 'x' })).toBe('cli');
    expect(scoreMode({ session: 'x', tui: true })).toBe('tui');
  });
});
