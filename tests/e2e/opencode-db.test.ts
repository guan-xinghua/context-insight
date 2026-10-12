// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { describe, it, expect, afterAll } from 'vitest';
import { listSessions } from '../../src/lib/ingest/adapters/opencode-db.ts';
import path from 'node:path';
import fs from 'node:fs';
import { materializeV1Fixture } from '../helpers/materialize-v1-fixture';

// v1 夹具物化私有副本（.db 二进制被 gitignore 吞掉从未入库）；afterAll 清理
const FIXTURE_DB = materializeV1Fixture('opencode-db-e2e');

afterAll(() => {
  fs.rmSync(path.dirname(FIXTURE_DB), { recursive: true, force: true });
});

describe('opencode-db adapter listSessions', () => {
  it('returns sessions with start/end time and totalTokens from the source db', () => {
    const sessions = listSessions(FIXTURE_DB);
    expect(sessions.length).toBe(2);

    for (const s of sessions) {
      expect(s).toHaveProperty('createdAt');
      expect(s).toHaveProperty('endedAt');
      expect(s).toHaveProperty('totalTokens');
      expect(typeof s.createdAt).toBe('string');
      expect(typeof s.totalTokens).toBe('number');
      expect(s.endedAt === null || typeof s.endedAt === 'string').toBe(true);
    }

    const small = sessions.find(s => s.id === 'ses_1b2c24167ffewAAb9pq2Gt1sUh');
    expect(small).toBeDefined();
    expect(small!.createdAt).toBe(new Date(1779412352664).toISOString());
    expect(small!.endedAt).toBe(new Date(1779412473064).toISOString());
    expect(small!.totalTokens).toBe(24554);

    const large = sessions.find(s => s.id === 'ses_2051a32a4ffevX0jGBWVDDEqCk');
    expect(large).toBeDefined();
    expect(large!.createdAt).toBe(new Date(1778030857563).toISOString());
    expect(large!.endedAt).toBe(new Date(1778059599321).toISOString());
    expect(large!.totalTokens).toBe(525509);
  });

  it('returns empty list for nonexistent path', () => {
    expect(listSessions('/nonexistent/path/nope.db')).toEqual([]);
  });
});
