// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { useRef } from 'react';
import { Box, Text, useInput } from 'ink';

interface TextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  onEscape?: () => void;
  placeholder?: string;
  focus?: boolean;
}

export function TextInput({ value, onChange, onSubmit, onEscape, placeholder, focus = true }: TextInputProps) {
  // 受控值的前置镜像：连续多次 stdin 写入落在同一次渲染前时，闭包里的 value 是
  // 旧值（逐字符连打只留最后一个字符）——ref 同步领先，链式拼接不失字
  const valueRef = useRef(value);
  valueRef.current = value;

  useInput((input, key) => {
    if (!focus) return;
    if (key.backspace || key.delete) {
      const next = valueRef.current.slice(0, -1);
      valueRef.current = next;
      onChange(next);
    } else if (key.escape) {
      onEscape?.();
    } else if (key.return) {
      onSubmit?.(valueRef.current);
    } else if (!key.ctrl && !key.meta) {
      const next = valueRef.current + input;
      valueRef.current = next;
      onChange(next);
    }
  }, { isActive: focus });

  return (
    <Box>
      {value.length === 0 && placeholder ? <Text color="gray">{placeholder}</Text> : null}
      <Text>{value}</Text>
      <Text color="gray">█</Text>
    </Box>
  );
}
