# Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
# This program is free software, you can redistribute it and/or modify it under the terms and conditions of
# CANN Open Software License Agreement Version 2.0 (the License).
# Please refer to the License for details. You may not use this file except in compliance with the License.
# THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
# INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
# See LICENSE in the root of the software repository for the full text of the License.
"""server 并发守卫 IT：同 basename 第二轮 409、释放后可重入、call_done 带error_msg。

背景（2026-08-27 实测）：两次 UI 触发共写 smart-agent-session-<taskId>.jsonl 出现
撕裂行，且后完成的一轮覆盖 *-analysis.json。守卫按 output_basename 拒绝并发。
用真实 ThreadingHTTPServer 起在本机随机端口，mock pipeline 阻塞在 Event 上模拟
第一轮进行中——不做函数级 mock，走完整 HTTP 数据流。
"""
from __future__ import annotations

import threading
import time
from http.server import ThreadingHTTPServer
from types import SimpleNamespace
from unittest.mock import patch

import requests

import server
from trajectory_analyzer import PerAgentCall, log_per_agent_progress


def test_call_done_records_error_msg():
    """失败样本的 run log 必须带 error_msg（此前只有类名 AnalysisError，无法定位根因）。"""
    cap = {}

    class _Logger:
        @staticmethod
        def log_system(subtype, data):
            cap["data"] = data

    ctx = SimpleNamespace(on_progress=None, logger=_Logger())
    limiter = SimpleNamespace(limit=lambda: 4, inflight=lambda: 2)
    call = PerAgentCall(
        done_n=19, agent_count=19, aid="sub-1ceddc031dce", dur_ms=0, err="AnalysisError",
        stats={"error": "AnalysisError",
               "error_msg": "LLM 请求超时（600s）。可能上下文过大或模型负载高。"})
    log_per_agent_progress(ctx, limiter, call)
    assert cap["data"]["error"] == "AnalysisError"
    assert cap["data"]["error_msg"].startswith("LLM 请求超时")


def test_concurrent_same_basename_409_then_reacquire(tmp_path):
    """同一 output_basename 并发第二轮 → 409；第一轮结束释放后同 basename 可重入。"""
    entered = threading.Event()   # pipeline 已进入 ⇒ 守卫已被第一轮占住
    release = threading.Event()   # 主线程放行第一轮
    result = SimpleNamespace(output_path="x.md", steps=[], analysis={})

    def _fake_pipeline(text, prompt_md, provider, ctx):
        entered.set()
        release.wait(timeout=30)
        return result

    with patch.object(server, "run_analysis_pipeline", _fake_pipeline):
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        port = httpd.server_address[1]
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            body = {"trajectoryText": "x",
                    "provider": {"baseUrl": "http://llm.test/v1", "apiKey": "k", "model": "m"},
                    "outputDir": str(tmp_path), "outputBasename": "it-409-basename"}

            first_result: list = []

            def _first():
                r = requests.post(f"http://127.0.0.1:{port}/analyze", json=body, timeout=60)
                first_result.append(r)

            t1 = threading.Thread(target=_first, daemon=True)
            t1.start()
            assert entered.wait(timeout=5), "第一轮未进入 pipeline"

            second = requests.post(f"http://127.0.0.1:{port}/analyze", json=body, timeout=30)
            assert second.status_code == 409
            assert "仍在进行中" in second.json()["error"]

            release.set()
            t1.join(timeout=30)
            assert first_result and first_result[0].status_code == 200

            third = requests.post(f"http://127.0.0.1:{port}/analyze", json=body, timeout=30)
            assert third.status_code == 200, "释放后同 basename 应可重新运行"
        finally:
            release.set()
            httpd.shutdown()
            server.release_run("it-409-basename")


def test_guard_release_on_error(tmp_path):
    """handler 异常路径（缺字段）也必须释放守卫，否则一次失败永久锁死该 session。"""
    body = {"provider": {"baseUrl": "http://llm.test/v1", "apiKey": "k", "model": "m"},
            "outputDir": str(tmp_path), "outputBasename": "it-release-basename"}
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        bad = requests.post(f"http://127.0.0.1:{port}/analyze", json=body, timeout=30)
        assert bad.status_code == 200  # NDJSON 流内报 error stage，HTTP 仍 200
        deadline = time.time() + 5
        while time.time() < deadline:
            with server.RUNS_LOCK:
                released = "it-release-basename" not in server.RUNS_INFLIGHT
            if released:
                break
            time.sleep(0.05)
        assert released, "缺字段异常后守卫未释放"
    finally:
        server.release_run("it-release-basename")
        httpd.shutdown()
