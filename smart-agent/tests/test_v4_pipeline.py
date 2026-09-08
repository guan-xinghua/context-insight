# Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
# This program is free software, you can redistribute it and/or modify it under the terms and conditions of
# CANN Open Software License Agreement Version 2.0 (the "License").
# Please refer to the License for details. You may not use this file except in compliance with the License.
# THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
# INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
# See LICENSE in the root of the software repository for the full text of the License.
"""Audit v4 纯逻辑测试：schema 校验、agent_io 合并、efficiency 确定性评级。

不启动 claude CLI（那在端到端手测覆盖）。
"""
from __future__ import annotations

import json

import pytest

from trajectory_analyzer import (
    validate_v4_schema,
    inject_v4_merge,
    efficiency_rating,
    SchemaError,
)


def test_efficiency_rating_thresholds():
    assert efficiency_rating({"errorCount": 0, "retryCount": 0, "turnCount": 5}) == "pass"
    assert efficiency_rating({"errorCount": 2, "retryCount": 0, "turnCount": 5}) == "weak"
    assert efficiency_rating({"errorCount": 0, "retryCount": 2, "turnCount": 5}) == "weak"
    assert efficiency_rating({"errorCount": 0, "retryCount": 0, "turnCount": 30}) == "weak"
    assert efficiency_rating({"errorCount": 5, "retryCount": 0, "turnCount": 5}) == "fail"
    assert efficiency_rating({"errorCount": 0, "retryCount": 5, "turnCount": 5}) == "fail"
    assert efficiency_rating({"errorCount": 0, "retryCount": 0, "turnCount": 80}) == "fail"


def _dim(rating, note=""):
    return {"rating": rating, "note": note}


def test_validate_v4_schema_accepts_minimal():
    obj = {
        "sessionSummary": "ok",
        "agents": [{"id": "main", "dimensions": {
            "completion": _dim("pass"), "quality": _dim("pass")}}],
    }
    validate_v4_schema(obj)  # 不抛


def test_validate_v4_schema_rejects_bad():
    with pytest.raises(SchemaError):
        validate_v4_schema({"agents": []})  # 缺 sessionSummary
    with pytest.raises(SchemaError):
        validate_v4_schema({"sessionSummary": "x", "agents": []})  # 空 agents
    with pytest.raises(SchemaError):
        validate_v4_schema({"sessionSummary": "x", "agents": [{"id": "main"}]})  # 缺 dimensions
    with pytest.raises(SchemaError):
        validate_v4_schema({"sessionSummary": "x", "agents": [
            {"id": "main", "dimensions": {"completion": _dim("bogus"), "quality": _dim("pass")}}]})  # 非法 rating


def test_inject_v4_merge_overwrites_envelope_and_fills_efficiency():
    agent_io = {
        "sessionId": "s1", "taskQuery": "do X", "agents": [
            {"id": "main", "parentId": None, "role": "main", "name": "main",
             "inputSummary": "task", "outputSummary": "done", "artifacts": ["Write: a.py"],
             "envelope": {"latencySec": 12.3, "tokensKt": 50, "turnCount": 4,
                          "toolCallCount": 9, "errorCount": 0, "retryCount": 0,
                          "reasoningTokensKt": 2}},
            {"id": "sub-a", "parentId": "main", "role": "subagent", "name": "general-purpose",
             "inputSummary": "dispatch", "outputSummary": "resp", "artifacts": ["Edit: b.md"],
             "envelope": {"latencySec": 45, "tokensKt": 150, "turnCount": 12,
                          "toolCallCount": 20, "errorCount": 3, "retryCount": 2,
                          "reasoningTokensKt": 5}},
        ]
    }
    llm = {"sessionSummary": "ok", "agents": [
        {"id": "main", "dimensions": {
            "completion": _dim("pass", "done"), "quality": _dim("pass", "good"),
            "efficiency": {"note": "lean"}}},
        {"id": "sub-a", "dimensions": {
            "completion": _dim("weak", "partial"), "quality": _dim("fail", "bad")}},
    ]}

    merged = inject_v4_merge(llm, agent_io)
    main = next(a for a in merged["agents"] if a["id"] == "main")
    sub = next(a for a in merged["agents"] if a["id"] == "sub-a")

    # envelope / artifacts / name 来自 agent_io
    assert main["envelope"]["turnCount"] == 4
    assert main["artifacts"] == ["Write: a.py"]
    assert sub["envelope"]["turnCount"] == 12
    assert sub["artifacts"] == ["Edit: b.md"]
    assert sub["name"] == "general-purpose"

    # efficiency.rating 服务端确定性填，LLM note 保留
    assert main["dimensions"]["efficiency"]["rating"] == "pass"
    assert main["dimensions"]["efficiency"]["note"] == "lean"
    assert sub["dimensions"]["efficiency"]["rating"] == "weak"

    # LLM 的 completion/quality 保留
    assert sub["dimensions"]["completion"]["rating"] == "weak"
    assert sub["dimensions"]["quality"]["rating"] == "fail"


def test_inject_v4_merge_stubs_missing_llm_agents():
    agent_io = {"agents": [
        {"id": "main", "parentId": None, "role": "main", "name": "main",
         "inputSummary": "", "outputSummary": "", "artifacts": [],
         "envelope": {"latencySec": 0, "tokensKt": 0, "turnCount": 1,
                      "toolCallCount": 0, "errorCount": 0, "retryCount": 0, "reasoningTokensKt": 0}},
        {"id": "sub-a", "parentId": "main", "role": "subagent", "name": "x",
         "inputSummary": "", "outputSummary": "", "artifacts": [],
         "envelope": {"latencySec": 0, "tokensKt": 0, "turnCount": 1,
                      "toolCallCount": 0, "errorCount": 0, "retryCount": 0, "reasoningTokensKt": 0}},
    ]}
    llm = {"sessionSummary": "ok", "agents": [
        {"id": "main", "dimensions": {"completion": _dim("pass"), "quality": _dim("pass")}}]}

    merged = inject_v4_merge(llm, agent_io)
    sub = next(a for a in merged["agents"] if a["id"] == "sub-a")
    # LLM 漏了 sub-a → 补 n-a stub
    assert sub["dimensions"]["completion"]["rating"] == "n-a"
    assert sub["dimensions"]["quality"]["rating"] == "n-a"
    assert sub["dimensions"]["efficiency"]["rating"] == "pass"  # envelope 干净
    assert json.dumps(merged, ensure_ascii=False)  # 结果可序列化


# ---- 429 限流三件套：渐进退避 / err_sig 判定贯通 / 补审波 ----

def _mk_provider():
    from trajectory_analyzer import AIProviderConfig
    return AIProviderConfig(base_url="http://llm.test/v1", api_key="k", model="m")


def _ok_resp():
    class _OkResponse:
        ok = True
        status_code = 200
        text = "{}"

        @staticmethod
        def json():
            return {"choices": [{"message": {"content": "{\"a\":1}", "model": "m"}}],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1}}
    return _OkResponse()


def _resp_429():
    class _RateLimitedResponse:
        ok = False
        status_code = 429
        text = '{"error":{"code":"1302","message":"您的账户已达到速率限制"}}'

        @staticmethod
        def json():
            return {}
    return _RateLimitedResponse()


def test_llm_request_429_backoff_then_success(monkeypatch):
    """429 → 渐进退避（4s、8s…+抖动）而非通用 2s；第三次成功返回。"""
    import trajectory_analyzer as ta
    sleeps = []
    monkeypatch.setattr(ta.requests, "post", lambda *a, **k: _resp_429() if len(sleeps) < 2 else _ok_resp())
    monkeypatch.setattr(ta.time, "sleep", lambda s: sleeps.append(s))
    monkeypatch.setattr(ta.random, "uniform", lambda a, b: 0.0)
    resp = ta.llm_request(_mk_provider(), {"model": "m", "messages": []})
    assert resp.content == '{"a":1}'
    assert sleeps == [4, 8]


def test_llm_request_429_exhausts_backoff(monkeypatch):
    """持续 429：5 档退避全用尽后再走通用 3 次预算，最终带 429 抛出。"""
    import trajectory_analyzer as ta
    posts = {"n": 0}
    sleeps = []
    monkeypatch.setattr(ta.requests, "post", lambda *a, **k: (posts.__setitem__("n", posts["n"] + 1), _resp_429())[1])
    monkeypatch.setattr(ta.time, "sleep", lambda s: sleeps.append(s))
    monkeypatch.setattr(ta.random, "uniform", lambda a, b: 0.0)
    with pytest.raises(Exception, match="429"):
        ta.llm_request(_mk_provider(), {"model": "m", "messages": []})
    assert len(sleeps) == len(ta.RATE_LIMIT_DELAYS) + 2  # 5 档退避 + 通用重试 2 次间隔
    assert posts["n"] == 1 + len(ta.RATE_LIMIT_DELAYS) + 2


def test_err_sig_classifies_rate_limit():
    """err 只看类名恒 False（AIMD 曾因此从未回退）；err_sig 贯通 error_msg 后可判。"""
    import trajectory_analyzer as ta
    sig = "AnalysisError: LLM API error: 429 {\"error\":{\"code\":\"1302\",\"message\":\"您的账户已达到速率限制\"}}"
    assert not ta.is_rate_or_timeout("AnalysisError")
    assert ta.is_rate_or_timeout(sig)
    assert ta.is_rate_limited(sig)
    assert not ta.is_rate_limited("AnalysisError: LLM 请求超时（600s）")  # 超时不进补审波


def test_rate_limited_retry_pass_recovers_agent(tmp_path, monkeypatch):
    """主波被 429 拒掉的 agent 在补审波重跑，n-a stub 被真实审计覆盖。"""
    import trajectory_analyzer as ta

    agents = [{"id": "A", "role": "main", "name": "a0", "turns": []},
              {"id": "B", "role": "sub", "name": "dev", "turns": []}]
    calls = {"B": 0}
    ok_dims = {"completion": {"rating": "pass", "evidence": "e"},
               "quality": {"rating": "weak", "evidence": "e"}, "efficiency": {}}

    def fake_audit(provider, agent, subagent_dir=None, tool_use_id=""):
        if agent["id"] == "B":
            calls["B"] += 1
            if calls["B"] == 1:
                return ({"completion": {"rating": "n-a", "note": "（agent 审计调用失败，回退 n-a）"},
                         "quality": {"rating": "n-a", "note": ""}, "efficiency": {}},
                        {"error": "AnalysisError",
                         "error_msg": "LLM API error: 429 您的账户已达到速率限制", "tool_use_id": tool_use_id})
        return (ok_dims, {"input_tokens": 10, "output_tokens": 5, "duration_ms": 100,
                          "model": "m", "result_content": "real", "tool_use_id": tool_use_id})

    monkeypatch.setattr(ta, "_audit_one_agent", fake_audit)
    ctx = ta.RunContext(output_dir=str(tmp_path), output_basename="retry-it", on_progress=lambda e: None)
    per_agent, bridges, _ = ta.run_per_agent_audit(agents, _mk_provider(), ctx)

    assert calls["B"] == 2, "被限流的 agent 应被补审一次"
    assert per_agent["B"]["completion"]["rating"] == "pass"
    bridge_b = next(b for b in bridges if b.get("agent_id") == "B" or b.get("tool_use_id"))
    assert any(b.get("result") == "real" for b in bridges), "补审成功后 bridge 应携带真实 result_content"
