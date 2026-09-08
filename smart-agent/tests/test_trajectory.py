# Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
# This program is free software, you can redistribute it and/or modify it under the terms and conditions of
# CANN Open Software License Agreement Version 2.0 (the "License").
# Please refer to the License for details. You may not use this file except in compliance with the License.
# THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
# INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
# See LICENSE in the root of the software repository for the full text of the License.
"""轨迹分析器 Python 版测试（对标 TS 版 trajectory-analyzer.test.ts）。

用真实 log1.md 验证 parser 正则，mock requests 验证 agent 循环。
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from unittest.mock import patch

import pytest

from trajectory_parser import (
    extract_skeleton,
    extract_skill_content,
    parse_stats,
    extract_gates,
    extract_errors,
    extract_key_sections,
    read_section,
)
from trajectory_analyzer import (
    build_chat_url,
    strip_code_fence,
    validate_schema,
    analyze_trajectory,
    run_analysis_pipeline,
    AIProviderConfig,
    AnalysisError,
    SchemaError,
    MAX_AGENT_ROUNDS,
    _tool_read,
    _tool_grep,
    _tool_bash,
    _tool_write_file,
)

TRAJECTORY_PATH = Path("/home/guan/code/03_cannbot_insight/logs/log1.md")
HAS_TRAJECTORY = TRAJECTORY_PATH.exists()

PROMPT_PATH = Path(__file__).resolve().parent.parent / "prompts" / "session-trajectory-analyse.md"
DEMO_PATH = Path(__file__).resolve().parent.parent / "src" / "lib" / "workflow-demo-analysis.json"

trajectory_text = TRAJECTORY_PATH.read_text(encoding="utf-8") if HAS_TRAJECTORY else ""

# 仅真读 log1.md fixture 的用例跳过；纯函数 parity 用例（build_chat_url/strip_code_fence
# 等）在任何环境都必须可跑——此前模块级 pytestmark 连坐跳过，parity 形同虚设
needs_trajectory = pytest.mark.skipif(not HAS_TRAJECTORY, reason="log1.md 不存在")


@needs_trajectory
def test_extract_skeleton():
    r = extract_skeleton(trajectory_text)
    invoke_count = sum(1 for s in r.skeleton if s.type == "invoke")
    dispatch_count = sum(1 for s in r.skeleton if s.type == "dispatch")
    first_invoke = next((s for s in r.skeleton if s.type == "invoke"), None)

    assert len(r.skeleton) == 84
    assert invoke_count == 20
    assert dispatch_count == 64
    assert r.turn_count == 102
    assert first_invoke.skill == "ops-registry-invoke-glacier"
    assert first_invoke.status == "ok"
    assert first_invoke.line == 27
    assert r.occurrences["ops-registry-invoke-glacier"] > 0


@needs_trajectory
def test_extract_skill_content():
    r = extract_skill_content(trajectory_text)
    assert r.skill_name == "ops-registry-invoke-glacier"
    assert len(r.skill_md) > 1000
    assert "<skill_content" in r.skill_md
    assert "</skill_content>" in r.skill_md
    assert r.skill_md.startswith('<skill_content name="ops-registry-invoke-glacier">')


@needs_trajectory
def test_parse_stats():
    stats = parse_stats(trajectory_text)
    assert "8.1h" in stats["duration"]
    assert "96.9M" in stats["tokens"]
    assert stats["turns"] == "1319"
    assert stats["subagents"] == "64"


@needs_trajectory
def test_extract_gates():
    gates = extract_gates(trajectory_text)
    assert len(gates) > 0
    assert all(g.result == "PASS" for g in gates)  # log1.md 全 PASS
    assert all(g.line > 0 for g in gates)


@needs_trajectory
def test_extract_errors():
    errors = extract_errors(trajectory_text)
    assert len(errors) > 0
    assert all(e.turn >= 0 for e in errors)
    assert all(len(e.snippet) > 0 for e in errors)
    first = errors[0]
    assert first.line_range[0] <= first.line_range[1]


@needs_trajectory
def test_read_section_lines():
    out = read_section(trajectory_text, {"lines": [1, 5]})
    lines = out.split("\n")
    assert len(lines) == 5
    assert len(out) > 0


@needs_trajectory
def test_read_section_section_4_1():
    out = read_section(trajectory_text, {"section": "§4.1"})
    assert out != ""
    assert "§4.1" in out


@needs_trajectory
def test_read_section_not_found():
    out = read_section(trajectory_text, {"section": "§99.99"})
    assert out == ""


# ---- schema 校验 ----

def _valid_analysis() -> dict:
    return {
        "sessionSummary": "ok",
        "workflowMeta": {"skillName": "test"},
        "sessionMeta": {"cpsExecuted": [], "cpsMissing": [], "phasesNotReached": []},
        "flow": [],
        "skillQuality": [],
        "workflowLevelIssues": [],
        "optimizationPriorities": [],
    }


def test_validate_schema_valid():
    validate_schema(_valid_analysis())


def test_validate_schema_missing_flow():
    a = _valid_analysis()
    del a["flow"]
    with pytest.raises(SchemaError, match="flow"):
        validate_schema(a)


def test_validate_schema_cps_executed_string():
    a = _valid_analysis()
    a["sessionMeta"]["cpsExecuted"] = "not-array"
    with pytest.raises(SchemaError, match="cpsExecuted"):
        validate_schema(a)


def test_validate_schema_non_object():
    with pytest.raises(SchemaError):
        validate_schema([1, 2, 3])


# ---- 关键片段提取 ----

@needs_trajectory
def test_extract_key_sections():
    sk = extract_skeleton(trajectory_text)
    sections = extract_key_sections(trajectory_text, sk)
    # 全部为 dispatch 类型
    assert len(sections) > 0
    assert all(s.task_prompt for s in sections)
    # task_prompt 应含 **Tool: task** 标记
    assert "**Tool: task**" in sections[0].task_prompt
    # 每个片段不超过 2000 字符
    assert all(len(s.task_prompt) <= 2000 for s in sections)
    assert all(len(s.task_result) <= 2000 for s in sections)


# ---- 工具单元测试 ----

def test_tool_read(tmp_path):
    f = tmp_path / "sample.txt"
    f.write_text("line1\nline2\nline3\nline4\nline5\n", encoding="utf-8")
    result = _tool_read({"file": str(f), "line_start": 1, "line_end": 3}, f)
    assert "line1" in result
    assert "line2" in result
    assert "line3" in result
    assert "line4" not in result


def test_tool_grep(tmp_path):
    f = tmp_path / "sample.txt"
    f.write_text("alpha\nbeta\ngamma\nbeta\n", encoding="utf-8")
    result = _tool_grep({"pattern": "beta", "file": str(f)}, f)
    lines = result.split("\n")
    assert len(lines) == 2
    assert lines[0].startswith("2:")
    assert "beta" in lines[0]
    assert lines[1].startswith("4:")
    assert "beta" in lines[1]


def test_tool_bash(tmp_path):
    result = _tool_bash({"command": "echo hello"}, str(tmp_path))
    assert "hello" in result


def test_tool_write_file(tmp_path):
    path = str(tmp_path / "output.txt")
    result = _tool_write_file({"path": path, "content": "test content"})
    assert "OK" in result
    assert Path(path).read_text(encoding="utf-8") == "test content"


# ---- Agent 循环 mock 测试 ----

def _mock_response(content: str):
    class FakeResp:
        ok = True
        status_code = 200
        text = content

        @staticmethod
        def json():
            return {"choices": [{"message": {"content": content}}]}
    return FakeResp()


def _tool_call_json(tool: str, args: dict, thought: str = "") -> str:
    return json.dumps({"tool": tool, "args": args, "thought": thought}, ensure_ascii=False)


@needs_trajectory
def test_agent_loop_success(tmp_path):
    """4 轮 agent 循环：write_file 骨架 → bash 填充 flow → bash 验证 → finish。"""
    analysis_path = str(tmp_path / "test-analysis.json")

    skeleton = json.dumps({
        "sessionSummary": "",
        "workflowMeta": {},
        "sessionMeta": {"cpsExecuted": [], "cpsMissing": [], "phasesNotReached": []},
        "flow": [],
        "skillQuality": [],
        "workflowLevelIssues": [],
        "optimizationPriorities": [],
    }, ensure_ascii=False)

    fill_code = (
        "import json; "
        f"d = json.load(open('{analysis_path}')); "
        "d['flow'] = [{'id': 'n1', 'skill': 'test', 'status': 'ok', 'problems': []}]; "
        "d['sessionSummary'] = 'ok'; "
        "d['workflowMeta'] = {'skillName': 'test'}; "
        f"f = open('{analysis_path}', 'w'); json.dump(d, f); f.close()"
    )

    validate_code = f"import json; json.load(open('{analysis_path}')); print('valid')"

    responses = iter([
        _mock_response(_tool_call_json("write_file",
            {"path": analysis_path, "content": skeleton}, "写入骨架")),
        _mock_response(_tool_call_json("bash",
            {"command": f'python3 -c "{fill_code}"'}, "填充 flow")),
        _mock_response(_tool_call_json("bash",
            {"command": f'python3 -c "{validate_code}"'}, "验证 JSON")),
        _mock_response(_tool_call_json("finish", {}, "完成")),
    ])

    def fake_post(*args, **kwargs):
        return next(responses)

    with patch("trajectory_analyzer.requests.post", side_effect=fake_post):
        provider = AIProviderConfig(base_url="https://example.com/v1", api_key="sk-test", model="test")
        result = run_analysis_pipeline(
            trajectory_text=trajectory_text,
            prompt_md="# prompt",
            provider=provider,
            output_dir=str(tmp_path),
            output_basename="test",
        )

    assert result.steps == 4
    assert os.path.exists(result.output_path)
    for key in ("sessionSummary", "workflowMeta", "sessionMeta", "flow",
                "skillQuality", "workflowLevelIssues", "optimizationPriorities"):
        assert key in result.analysis
    assert len(result.analysis["flow"]) == 1
    assert result.analysis["sessionSummary"] == "ok"
    assert result.analysis["workflowMeta"]["skillName"] == "test"


@needs_trajectory
def test_agent_loop_max_rounds(tmp_path):
    """LLM 永远返回 read，50 轮后输出文件不存在 → AnalysisError。"""
    read_call = _tool_call_json("read",
        {"file": str(tmp_path / "test-max.md"), "line_start": 1, "line_end": 10}, "reading")

    def fake_post(*args, **kwargs):
        return _mock_response(read_call)

    with patch("trajectory_analyzer.requests.post", side_effect=fake_post):
        provider = AIProviderConfig(base_url="https://example.com/v1", api_key="sk-test", model="test")
        with pytest.raises(AnalysisError, match="输出文件不存在"):
            run_analysis_pipeline(
                trajectory_text=trajectory_text,
                prompt_md="# prompt",
                provider=provider,
                output_dir=str(tmp_path),
                output_basename="test-max",
            )


def test_analyze_trajectory_file_not_found(tmp_path):
    provider = AIProviderConfig(base_url="https://example.com/v1", api_key="sk-test", model="test")
    with pytest.raises(AnalysisError, match="not found"):
        analyze_trajectory(
            trajectory_path="/nonexistent/file.md",
            provider=provider,
            prompt_path=str(PROMPT_PATH) if PROMPT_PATH.exists() else None,
            output_dir=str(tmp_path),
        )


def test_build_chat_url_any_version_segment():
    """URL 归一 parity 用例：与 TS 侧 tests/scoring-semantic.test.ts 的 buildChatUrl 表逐条同表，改动两侧同步。"""
    # 裸主机补 /v1；任意版本段直接拼（火山方舟 /api/v3）；已含端点原样
    assert build_chat_url("http://llm.test") == "http://llm.test/v1/chat/completions"
    assert build_chat_url("http://llm.test/v1/") == "http://llm.test/v1/chat/completions"
    assert build_chat_url("http://llm.test/v1") == "http://llm.test/v1/chat/completions"
    assert build_chat_url("https://gw.apigateway-cn-beijing.volceapi.com/api/v3") == \
        "https://gw.apigateway-cn-beijing.volceapi.com/api/v3/chat/completions"
    assert build_chat_url("http://llm.test/api/v3/chat/completions") == "http://llm.test/api/v3/chat/completions"
    # 首尾空白先 strip：粘贴带入的尾随空格会让版本段正则失配，拼出 /v4%20/v1/… 畸形路径
    # （2026-08-27 实测 bigmodel /api/coding/paas/v4␣ → 404 path=/v4/20/v1/chat/completions）
    assert build_chat_url(" https://open.bigmodel.cn/api/coding/paas/v4 ") == \
        "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions"
    assert build_chat_url("http://llm.test/v1\n") == "http://llm.test/v1/chat/completions"


def test_strip_code_fence():
    """围栏剥离 parity 用例：与 TS 侧 tests/scoring-semantic.test.ts 的 stripJsonFence 表同表，改动两侧同步。"""
    assert strip_code_fence('```json\n{"a": 1}\n```') == '{"a": 1}'
    assert strip_code_fence('```\n{"a": 1}\n```') == '{"a": 1}'
    assert strip_code_fence('{"a": 1}') == '{"a": 1}'
    assert strip_code_fence('```json\n{"a": 1}') == '{"a": 1}'
    assert strip_code_fence('  ```json\n{"a": 1}\n```  \n') == '{"a": 1}'
