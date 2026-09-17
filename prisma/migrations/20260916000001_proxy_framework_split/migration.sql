-- Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
-- This program is free software, you can redistribute it and/or modify it under the terms and conditions of
-- CANN Open Software License Agreement Version 2.0 (the License).
-- Please refer to the License for details. You may not use this file except in compliance with the License.
-- THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
-- INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
-- See LICENSE in the root of the software repository for the full text of the License.

-- 方案一（同 sid 双会话共存）：proxy 捕获行的 framework 追加 '-proxy' 记录后缀
-- （claude-code-proxy / opencode-proxy / codex-proxy / cannbot-proxy）——
-- (taskId, framework) 唯一索引下与同 sid 的原生会话（claude-code / opencode / …）
-- 各占一行。insight 导出行（cannbot-insight）保持导出身份不参与拆分。
-- 后缀化必须按 version 标记推导（与 recordingClassOfSessionRow /
-- proxyRecordingFrameworkFromVersion 同源：marker → agent + '-proxy'），不能
-- 追加到现有 framework 上：framework 误标史（claude-code→opencode 修正前）
-- 遗留的行按现值追加会得到 claude-code-proxy，而导入匹配按 version 推导出
-- opencode-proxy——分叉导致重导时匹配不上、旧行残留永不合并；仅在 version
-- 不可推导（marker 缺失）时才回退「追加到现有 framework」。
UPDATE "Session"
SET "framework" = CASE
  WHEN "version" LIKE '%opencode-proxy' THEN 'opencode-proxy'
  WHEN "version" LIKE '%codex-proxy' THEN 'codex-proxy'
  WHEN "version" LIKE '%cannbot-proxy' THEN 'cannbot-proxy'
  WHEN "version" LIKE '%claude-proxy' THEN 'claude-code-proxy'
  ELSE "framework" || '-proxy'
END
WHERE "version" LIKE '%-proxy'
  AND "framework" NOT LIKE '%-proxy'
  AND "framework" <> 'cannbot-insight';
