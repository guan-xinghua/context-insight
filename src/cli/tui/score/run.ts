// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the License).
// Please refer to the License for details. You do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Insight Score TUI 入口：真终端走 TuiAltScreen（应用自持定高视口），组件与终端解耦便于契约测试。
import { ProcessTerminal, TuiAltScreen, matchesKey } from '@earendil-works/pi-tui';
import { ScoreApp, type ScoreTuiProps } from './app';

export type { ScoreTuiProps } from './app';

export async function runScoreTui(initial?: ScoreTuiProps): Promise<number> {
  const terminal = new ProcessTerminal();
  const tui = new TuiAltScreen(terminal);
  let stopped = false;
  let resolveExit: () => void = () => {};
  const exited = new Promise<void>(resolve => { resolveExit = resolve; });
  const quit = (): void => {
    if (stopped) return;
    stopped = true;
    try { tui.stop(); } catch { /* stop 幂等 */ }
    resolveExit();
  };
  const app = new ScoreApp({
    cols: () => terminal.columns,
    rows: () => terminal.rows,
    requestRender: () => { if (!stopped) tui.requestRender(); },
    onQuit: quit,
    props: initial,
  });
  tui.addChild(app);
  tui.setFocus(app);
  tui.addInputListener(data => { if (matchesKey(data, 'ctrl+c')) quit(); return undefined; });
  app.init();
  tui.start();
  await exited;
  const code = process.exitCode;
  process.exitCode = undefined;
  return typeof code === 'number' ? code : 0;
}
