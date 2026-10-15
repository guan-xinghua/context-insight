// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details on how you could use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { describe, it, expect } from 'vitest';
import {
  parseReadToolArgs,
  isSkillToolCall,
  skillEventTypeOf,
  extractSkillName,
  extractSkillVersion,
  normalizeToolResultPayload,
  unwrapSkillContent,
  SHELL_TOOL_NAMES,
  isShellToolCall,
  shellCommandOf,
  shellCommandArgsOf,
} from '../../src/lib/tool-conventions.ts';

describe('tool-conventions（框架工具调用约定）', () => {
  describe('parseReadToolArgs', () => {
    it('parses filePath (opencode 新版) with offset/limit/summary', () => {
      const r = parseReadToolArgs('{"filePath":"/src/foo.ts","offset":10,"limit":20,"summary":"foo.ts"}');
      expect(r).toEqual({ filePath: '/src/foo.ts', offset: 10, limit: 20, summary: 'foo.ts' });
    });

    it('parses file_path (Claude Code)', () => {
      const r = parseReadToolArgs('{"file_path":"/src/foo.ts"}');
      expect(r).toEqual({ filePath: '/src/foo.ts', offset: null, limit: null, summary: null });
    });

    it('parses path (opencode 旧版)——历史缺陷：该键曾整页丢失', () => {
      const r = parseReadToolArgs('{"path":"/src/foo.ts"}');
      expect(r).toEqual({ filePath: '/src/foo.ts', offset: null, limit: null, summary: null });
    });

    it('key precedence: 具体键先于通用键', () => {
      const r = parseReadToolArgs('{"filePath":"/a.ts","path":"/b.ts"}');
      expect(r!.filePath).toBe('/a.ts');
    });

    it('returns null for null / invalid JSON / non-object', () => {
      expect(parseReadToolArgs(null)).toBeNull();
      expect(parseReadToolArgs('not json')).toBeNull();
      expect(parseReadToolArgs('"just a string"')).toBeNull();
      expect(parseReadToolArgs('42')).toBeNull();
    });

    it('no path key → filePath null but sibling keys visible', () => {
      const r = parseReadToolArgs('{"offset":5}');
      expect(r).toEqual({ filePath: null, offset: 5, limit: null, summary: null });
    });

    it('non-string / empty path values are ignored', () => {
      const r = parseReadToolArgs('{"path":123}');
      expect(r!.filePath).toBeNull();
      const r2 = parseReadToolArgs('{"path":""}');
      expect(r2!.filePath).toBeNull();
    });

    it('non-number offset/limit normalized to null', () => {
      const r = parseReadToolArgs('{"filePath":"/a.ts","offset":"10","limit":true}');
      expect(r).toEqual({ filePath: '/a.ts', offset: null, limit: null, summary: null });
    });
  });

  describe('isSkillToolCall', () => {
    it('matches Skill/skill/load_skill/skill/*', () => {
      expect(isSkillToolCall('Skill')).toBe(true);
      expect(isSkillToolCall('skill')).toBe(true);
      expect(isSkillToolCall('load_skill')).toBe(true);
      expect(isSkillToolCall('skill/load_skill')).toBe(true);
      expect(isSkillToolCall('skill/invoke')).toBe(true);
      expect(isSkillToolCall('skill/foo')).toBe(true);
    });
    it('rejects non-skill tools', () => {
      expect(isSkillToolCall('Read')).toBe(false);
      expect(isSkillToolCall('Write')).toBe(false);
      expect(isSkillToolCall('Bash')).toBe(false);
    });
  });

  describe('skillEventTypeOf', () => {
    it('load_skill 系 = load；invoke 直名 = invoke；其余族 = use', () => {
      expect(skillEventTypeOf('load_skill')).toBe('load');
      expect(skillEventTypeOf('skill/load_skill')).toBe('load');
      expect(skillEventTypeOf('skill')).toBe('invoke');
      expect(skillEventTypeOf('skill/invoke')).toBe('invoke');
      expect(skillEventTypeOf('skill/foo')).toBe('use');
    });
  });

  describe('extractSkillName', () => {
    it('reads args.skill (Claude Code)', () => {
      expect(extractSkillName('Skill', '{"skill":"a2h-spec"}')).toBe('a2h-spec');
    });
    it('falls back to skill_name / name', () => {
      expect(extractSkillName('skill', '{"skill_name":"x"}')).toBe('x');
      expect(extractSkillName('skill', '{"name":"y"}')).toBe('y');
    });
    it('reads args.id (opencode 新版)——历史缺陷：该键曾回落字面量 "skill"', () => {
      expect(extractSkillName('skill', '{"id":"ops-registry-invoke-fusion-design"}')).toBe('ops-registry-invoke-fusion-design');
    });
    it('key precedence: name 先于 id（并存时具体键优先）', () => {
      expect(extractSkillName('skill', '{"name":"real","id":"other"}')).toBe('real');
    });
    it('falls back to toolName strip when no args', () => {
      expect(extractSkillName('skill/ops-spec-gen', null)).toBe('ops-spec-gen');
    });
    it('falls back to toolName strip on bad json', () => {
      expect(extractSkillName('skill/foo', 'not json')).toBe('foo');
    });
  });

  describe('extractSkillVersion', () => {
    it('reads numeric version', () => {
      expect(extractSkillVersion('{"skill":"x","version":2}')).toBe(2);
    });
    it('returns null for missing / non-numeric / bad json', () => {
      expect(extractSkillVersion('{"skill":"x"}')).toBeNull();
      expect(extractSkillVersion('{"version":"2"}')).toBeNull();
      expect(extractSkillVersion('not json')).toBeNull();
      expect(extractSkillVersion(null)).toBeNull();
    });
  });

  describe('normalizeToolResultPayload（结果负载归一）', () => {
    it('字符串直通（opencode 1.x）', () => {
      expect(normalizeToolResultPayload('Read file /a.ts, lines 1-3')).toBe('Read file /a.ts, lines 1-3');
    });
    it('null / undefined → null', () => {
      expect(normalizeToolResultPayload(null)).toBeNull();
      expect(normalizeToolResultPayload(undefined)).toBeNull();
    });
    it('内容块数组取 text 拼接（opencode 2.x）——历史缺陷：整体 stringify 使 \\n 成转义字面量，行级解析全废', () => {
      const blocks = [
        { type: 'text', text: 'Read file /src/app.py, lines 1-2' },
        { type: 'text', text: '1: import os\n2: pass' },
      ];
      expect(normalizeToolResultPayload(blocks)).toBe('Read file /src/app.py, lines 1-2\n1: import os\n2: pass');
    });
    it('混合块跳过非 text（图片等），只拼文本', () => {
      const blocks = [
        { type: 'image', source: { type: 'base64' } },
        { type: 'text', text: 'done' },
      ];
      expect(normalizeToolResultPayload(blocks)).toBe('done');
    });
    it('空文本块 / 无文本块 / 空数组回落 JSON 序列化（保持原行为）', () => {
      expect(normalizeToolResultPayload([])).toBe('[]');
      expect(normalizeToolResultPayload([{ type: 'image' }])).toBe('[{"type":"image"}]');
      expect(normalizeToolResultPayload([{ type: 'text', text: '' }])).toBe('[{"type":"text","text":""}]');
    });
    it('其他对象回落 JSON 序列化', () => {
      expect(normalizeToolResultPayload({ output: 'x' })).toBe('{"output":"x"}');
    });
    it('字符串化嵌套形态（湖原生导出）：字符串值是 stringify 的内容块数组 → 剥出文本——真机 ecb 会话 276/276 全此形态', () => {
      const nested = JSON.stringify([
        { type: 'text', text: 'Read file /src/app.py, lines 1-2' },
        { type: 'text', text: '1: import os\n2: pass' },
      ]);
      expect(normalizeToolResultPayload(nested)).toBe('Read file /src/app.py, lines 1-2\n1: import os\n2: pass');
    });
    it('前缀像但非内容块形态的字符串直通（普通 JSON 数组文本 / 坏 JSON）', () => {
      expect(normalizeToolResultPayload('[{"type":"image","src":"x"}]')).toBe('[{"type":"image","src":"x"}]');
      expect(normalizeToolResultPayload('[{"type":"text","text":""}]')).toBe('[{"type":"text","text":""}]');
      expect(normalizeToolResultPayload('[{"type":"text"')).toBe('[{"type":"text"');
    });
    it('普通文本结果（不以 [{"type": 开头）零成本直通', () => {
      expect(normalizeToolResultPayload('{"output":"x"}')).toBe('{"output":"x"}');
      expect(normalizeToolResultPayload('Read file /a.ts, lines 1-3')).toBe('Read file /a.ts, lines 1-3');
    });
  });

  describe('unwrapSkillContent（skill 结果协议壳）', () => {
    it('剥 <skill_content> 壳并 trim', () => {
      expect(unwrapSkillContent('<skill_content name="demo">\n# Demo\n\nbody\n</skill_content>')).toBe('# Demo\n\nbody');
    });
    it('无壳 / 空 → null', () => {
      expect(unwrapSkillContent('Base directory for this skill: /x\n\n# Foo')).toBeNull();
      expect(unwrapSkillContent('')).toBeNull();
      expect(unwrapSkillContent(null)).toBeNull();
      expect(unwrapSkillContent(undefined)).toBeNull();
    });
  });

  describe('shell 命令工具族', () => {
    it('族成员：bash / shell / exec / exec_command（大小写不敏感）——历史缺陷：D2 只认 bash', () => {
      expect(SHELL_TOOL_NAMES).toEqual(['bash', 'shell', 'exec', 'exec_command']);
      for (const n of ['bash', 'shell', 'exec', 'exec_command', 'Bash', 'SHELL', 'Exec_Command']) {
        expect(isShellToolCall(n)).toBe(true);
      }
      expect(isShellToolCall('read')).toBe(false);
      expect(isShellToolCall('write')).toBe(false);
      expect(isShellToolCall('task')).toBe(false);
    });
    it('shellCommandOf：字符串 command 直取（opencode bash/shell）', () => {
      expect(shellCommandOf('{"command":"cat a.txt && sed -n 5,9p b.txt"}')).toBe('cat a.txt && sed -n 5,9p b.txt');
    });
    it('shellCommandOf：数组 command join（codex exec_command）', () => {
      expect(shellCommandOf('{"command":["bash","-lc","cat a.txt"]}')).toBe('bash -lc cat a.txt');
    });
    it('shellCommandOf：无 command 键 / 坏 JSON / null → null（调用方回落原始 args）', () => {
      expect(shellCommandOf('{"input":"exec_command({cmd:\\"...\\"})"}')).toBeNull();
      expect(shellCommandOf('not json')).toBeNull();
      expect(shellCommandOf(null)).toBeNull();
      expect(shellCommandOf('{"command":[]}')).toBeNull();
    });
    it('shellCommandArgsOf：字符串 → [整串]；数组 → 各元素（载荷在末元素，逐元素防漏）', () => {
      expect(shellCommandArgsOf('{"command":"cat a && cat b"}')).toEqual(['cat a && cat b']);
      expect(shellCommandArgsOf('{"command":["bash","-lc","cat a; rg foo b"]}')).toEqual(['bash', '-lc', 'cat a; rg foo b']);
      expect(shellCommandArgsOf('{"input":"x"}')).toEqual([]);
    });
  });
});
