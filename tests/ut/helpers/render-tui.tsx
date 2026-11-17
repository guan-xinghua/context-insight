// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the License).
// Please refer to the License for details. You do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import React from 'react';
import { EventEmitter } from 'node:events';
import { render as inkRender } from 'ink';

// 自建 TUI 渲染流：列宽在构造时注入（第一帧就对）。ink-testing-library 的
// Stdout.columns 是写死 100 的原型 getter，事后覆盖会造成首帧 100 列 → Yoga
// 布局缓存污染 → 后续帧按 100 列重排（行折断/框撕裂）。debug:true 让 ink 每
// 次渲染写整帧（无光标 diff），帧文本即合成结果
class FixedStdout extends EventEmitter {
  frames: string[] = [];
  private last: string | null = null;
  constructor(public columns: number, public rows: number) { super(); }
  write = (frame: string) => { this.frames.push(frame); this.last = frame; };
  lastFrame = () => this.last;
}
class FixedStdin extends EventEmitter {
  isTTY = true;
  private data: string | null = null;
  write = (data: string) => {
    this.data = data;
    this.emit('readable');
    this.emit('data', data);
  };
  setEncoding() { /* no-op */ }
  setRawMode() { /* no-op */ }
  resume() { /* no-op */ }
  pause() { /* no-op */ }
  ref() { /* no-op */ }
  unref() { /* no-op */ }
  read = () => {
    const d = this.data;
    this.data = null;
    return d;
  };
}

export function renderTui(element: React.ReactElement, columns = 160, rows = 40) {
  const stdout = new FixedStdout(columns, rows);
  const stdin = new FixedStdin();
  const instance = inkRender(element, {
    // ink 渲染选项收窄为内部流类型，测试替身按契约实现（同 ink-testing-library）
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return {
    rerender: instance.rerender,
    unmount: instance.unmount,
    cleanup: instance.cleanup,
    stdout,
    stdin,
    frames: stdout.frames,
    lastFrame: () => stdout.lastFrame(),
    getPlainText: () => stdout.lastFrame()?.replace(/\x1b\[[0-9;]*m/g, '') ?? '',
    pressKey: (key: string) => stdin.write(key),
    pressEnter: () => stdin.write('\r'),
    pressEscape: () => stdin.write('\x1b'),
    pressUp: () => stdin.write('\x1b[A'),
    pressDown: () => stdin.write('\x1b[B'),
    pressCtrlC: () => stdin.write('\x03'),
  };
}
