// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// verdict 中文显示文案的唯一权威源：数据层存英文枚举（聚合逻辑用），展示层统一翻译。
// 服务端（judge 证据标签）与客户端组件（徽标）共读这一份——两份手抄必漂移。
// 显示层可在其上叠加语境化覆盖（如 D2 徽标「违规（否决）」），共享枚举本身只在这里改。

export const VERDICT_TEXT: Record<string, string> = {
  covered: '已覆盖', partial: '部分覆盖', missing: '未覆盖',
  met: '达标', unmet: '未达标', 'not-run': '未执行', unidentifiable: '无法识别',
  clean: '无发现', violation: '违规', suspected: '疑似',
  authorized: '已授权', unauthorized: '未授权',
  pass: '通过', fail: '未通过', passed: '通过', failed: '未通过',
  normal: '正常结束', error: '错误崩溃', truncated: '上下文截断', unknown: '无法确定',
  completed: '自报完成', incomplete: '自报未完成',
  high: '对账率高', mid: '对账率中', low: '对账率低',
  none: '未验证',
  完成: '完成', 未完成: '未完成', 无法判定: '无法判定',
};

export const verdictText = (v: string): string => VERDICT_TEXT[v] ?? v;
