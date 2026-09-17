"use client"
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { useState, useCallback } from "react"
import { CopyIcon, CheckIcon } from "lucide-react"
import { cn } from "@/lib/utils"

export function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [text])

  return (
    <span
      role="button"
      tabIndex={0}
      // inline-flex 居中是修复的一部分：固定尺寸盒子里的内联 SVG 按基线排版、
      // 被继承行高顶出盒子（垂直错位的根源），flex 容器让图标始终在盒内居中，
      // 与行尾三角（文本字形）对齐。基类始终生效，caller className 叠加其上。
      className={cn(
        "inline-flex items-center justify-center cursor-pointer shrink-0",
        className ?? "size-4 text-muted-foreground hover:text-foreground transition-colors"
      )}
      onClick={handleCopy}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleCopy() }}
      title="Copy"
    >
      {copied ? <CheckIcon className="size-3 text-emerald-500" /> : <CopyIcon className="size-3" />}
    </span>
  )
}
