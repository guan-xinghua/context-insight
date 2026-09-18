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

另有 outputDir/outputBasename 收敛 IT（安全修复）：outputBasename 剥离路径
组件（../ 与绝对路径前缀不再参与 os.path.join），outputDir 必须落在允许根
（cwd/PROJECT_ROOT 的 tmp、logs + CANNBOT_AGENT_OUTPUT_ROOTS 扩展）内，
否则回退端点默认目录。
"""
from __future__ import annotations

import os
import threading
import time
from http.server import ThreadingHTTPServer
from pathlib import Path
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


def test_concurrent_same_basename_409_then_reacquire(tmp_path, monkeypatch):
    """同一 output_basename 并发第二轮 → 409；第一轮结束释放后同 basename 可重入。"""
    monkeypatch.setenv("CANNBOT_AGENT_OUTPUT_ROOTS", str(tmp_path))
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
                    "provider": _LLM_PROVIDER,
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


def test_guard_release_on_error(tmp_path, monkeypatch):
    """handler 异常路径（缺字段）也必须释放守卫，否则一次失败永久锁死该 session。"""
    monkeypatch.setenv("CANNBOT_AGENT_OUTPUT_ROOTS", str(tmp_path))
    body = {"provider": _LLM_PROVIDER,
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


def _start_server() -> tuple[ThreadingHTTPServer, int]:
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, port


_LLM_PROVIDER = {"baseUrl": "http://llm.test/v1", "apiKey": "k", "model": "m"}


def _capture_compress(captured: dict):
    """假压缩器：记录 ctx 关键字段，按端点约定写产物文件并返回产物路径。"""
    def _fake(text, provider, prompt_path, ctx):
        captured["output_dir"] = ctx.output_dir
        captured["basename"] = ctx.output_basename
        captured["prompt_path"] = prompt_path
        out = Path(ctx.output_dir) / f"{ctx.output_basename}-compressed.md"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text, encoding="utf-8")
        return str(out)
    return _fake


def test_output_basename_traversal_confined(tmp_path, monkeypatch):
    """outputBasename 带 ../ 或绝对路径前缀 → 只取最后一段，产物落在允许根内。"""
    monkeypatch.setenv("CANNBOT_AGENT_OUTPUT_ROOTS", str(tmp_path))
    captured = {}

    with patch.object(server, "compress_trajectory", _capture_compress(captured)):
        httpd, port = _start_server()
        try:
            body = {"trajectoryText": "x",
                    "provider": _LLM_PROVIDER,
                    "outputDir": str(tmp_path),
                    "outputBasename": "sess/../../../tmp/evil"}
            r = requests.post(f"http://127.0.0.1:{port}/compress", json=body, timeout=30)
            assert r.status_code == 200
            assert captured.get("basename") == "evil", "路径前缀必须被剥掉"
            assert captured.get("output_dir") == str(tmp_path.resolve())
            assert (tmp_path / "evil-compressed.md").exists(), "产物必须落在允许根内"
            assert (tmp_path / "smart-agent-evil-compress.jsonl").exists()
        finally:
            httpd.shutdown()
            server.release_run("evil")


def test_output_dir_outside_roots_falls_back_to_default(tmp_path, monkeypatch):
    """outputDir 在允许根之外（如 /）→ 回退端点默认目录，不写根外任何位置。"""
    monkeypatch.chdir(tmp_path)
    captured = {}

    with patch.object(server, "compress_trajectory", _capture_compress(captured)):
        httpd, port = _start_server()
        try:
            body = {"trajectoryText": "x",
                    "provider": _LLM_PROVIDER,
                    "outputDir": "/",
                    "outputBasename": "it-outside-roots"}
            r = requests.post(f"http://127.0.0.1:{port}/compress", json=body, timeout=30)
            assert r.status_code == 200
            assert captured.get("output_dir") == os.path.join(str(tmp_path), "logs"), "根外目录必须回退默认"
            assert (tmp_path / "logs" / "it-outside-roots-compressed.md").exists()
        finally:
            httpd.shutdown()
            server.release_run("it-outside-roots")


def test_output_dir_bare_root_falls_back(tmp_path, monkeypatch):
    """裸 cwd（即项目根）不在允许根内——允许根仅 tmp/logs 子目录 + env 扩展。"""
    monkeypatch.chdir(tmp_path)
    captured = {}

    with patch.object(server, "compress_trajectory", _capture_compress(captured)):
        httpd, port = _start_server()
        try:
            body = {"trajectoryText": "x",
                    "provider": _LLM_PROVIDER,
                    "outputDir": str(tmp_path),
                    "outputBasename": "it-bare-root"}
            r = requests.post(f"http://127.0.0.1:{port}/compress", json=body, timeout=30)
            assert r.status_code == 200
            assert captured.get("output_dir") == os.path.join(str(tmp_path), "logs"), \
                "裸根必须回退默认目录，项目树内任意位置不可写"
        finally:
            httpd.shutdown()
            server.release_run("it-bare-root")


def test_prompt_path_confined_to_prompts_dir():
    """promptPath 收敛单元口径：PROMPTS_DIR 外/不存在/非字符串 → 回退默认。"""
    default = os.path.join(server.PROMPTS_DIR, "trajectory-compress.md")
    assert server.confined_prompt_path("/etc/passwd") == default
    assert server.confined_prompt_path("../../etc/passwd") == default
    assert server.confined_prompt_path(None) == default
    assert server.confined_prompt_path("") == default
    assert server.confined_prompt_path(os.path.join(server.PROMPTS_DIR, "no-such-prompt.md")) == default
    legit = os.path.join(server.PROMPTS_DIR, "trajectory-compress.md")
    assert server.confined_prompt_path(legit) == os.path.realpath(legit)


def test_prompt_path_http_level_confined(tmp_path, monkeypatch):
    """HTTP 层：/compress 请求体 promptPath 指向敏感文件 → 压缩器收到默认 prompt。"""
    monkeypatch.setenv("CANNBOT_AGENT_OUTPUT_ROOTS", str(tmp_path))
    captured = {}

    with patch.object(server, "compress_trajectory", _capture_compress(captured)):
        httpd, port = _start_server()
        try:
            body = {"trajectoryText": "x",
                    "provider": _LLM_PROVIDER,
                    "outputDir": str(tmp_path),
                    "promptPath": "/etc/passwd",
                    "outputBasename": "it-prompt-guard"}
            r = requests.post(f"http://127.0.0.1:{port}/compress", json=body, timeout=30)
            assert r.status_code == 200
            assert captured.get("prompt_path") == os.path.join(server.PROMPTS_DIR, "trajectory-compress.md"), \
                "PROMPTS_DIR 外的 promptPath 必须回退默认，不得读敏感文件"
        finally:
            httpd.shutdown()
            server.release_run("it-prompt-guard")
