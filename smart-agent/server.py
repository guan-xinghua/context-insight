# Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
# This program is free software, you can redistribute it and/or modify it under the terms and conditions of
# CANN Open Software License Agreement Version 2.0 (the "License").
# Please refer to the License for details. You may not use this file except in compliance with the License.
# THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
# INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
# See LICENSE in the root of the software repository for the full text of the License.
"""smart-agent HTTP 服务（stdlib，免装 fastapi）。

POST /analyze  body: {trajectoryText, provider:{baseUrl,apiKey,model}, promptMd?, outputDir?, outputBasename?}
  → NDJSON stream: progress events → {stage:"result", outputPath, rounds, analysis}
POST /compress  body: 同 /analyze 但只压缩 → NDJSON stream → {stage:"result", outputPath}
POST /compress-and-analyze  body: 同 /analyze → 先压缩再分析，单 NDJSON 流
GET /health → {status: ok, service: cannbot-smart-agent}
  service 标识供启动器验明正身：带通用 /health 的无关服务（Actuator、
  dev server 等）不得被误认为 smart-agent 而复用/击杀
"""
from __future__ import annotations

import json
import logging
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from trajectory_analyzer import run_analysis_pipeline, AIProviderConfig, AnalysisError, SchemaError, RunContext
from trajectory_compressor import compress_trajectory, deterministic_compress
from trajectory_parser import inject_flow_metrics
from jsonl_logger import JsonlLogger

PORT = int(os.environ.get("CANNBOT_AGENT_PORT", "21026"))
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROMPTS_DIR = os.path.join(PROJECT_ROOT, "prompts")


def _safe_output_basename(raw: object) -> str:
    """outputBasename 归一化：只取最后一段路径组件，剥掉一切遍历前缀。"""
    name = os.path.basename(str(raw)) if raw else "session"
    name = name.strip()
    if name in ("", ".", ".."):
        return "session"
    return name


def _output_roots() -> list[str]:
    """outputDir 允许根：cwd / 项目根下的 tmp、logs 子目录 + 环境变量扩展。

    刻意不含裸 cwd/项目根本身：产物文件名嵌请求方可控的 outputBasename，
    裸根会让整个项目树（含 .git/src/prompts）落入可写范围。
    """
    extras = [p.strip() for p in os.environ.get("CANNBOT_AGENT_OUTPUT_ROOTS", "").split(",") if p.strip()]
    candidates = [
        os.path.join(os.getcwd(), "tmp"), os.path.join(os.getcwd(), "logs"),
        os.path.join(PROJECT_ROOT, "tmp"), os.path.join(PROJECT_ROOT, "logs"),
        *extras,
    ]
    roots: list[str] = []
    for p in candidates:
        rp = os.path.realpath(p)
        if rp not in roots:
            roots.append(rp)
    return roots


def _confined_output_dir(candidate: object, default: str) -> str:
    """请求体 outputDir 落在允许根内才采用，否则回退端点默认目录。"""
    if not isinstance(candidate, str) or not candidate.strip():
        return default
    rp = os.path.realpath(candidate)
    if any(rp == root or rp.startswith(root + os.sep) for root in _output_roots()):
        return rp
    return default


def confined_prompt_path(candidate: object) -> str:
    """promptPath 收敛：仅允许 PROMPTS_DIR 内真实存在的文件，其余回退默认。"""
    default = os.path.join(PROMPTS_DIR, "trajectory-compress.md")
    if not isinstance(candidate, str) or not candidate.strip():
        return default
    rp = os.path.realpath(candidate)
    prompts_root = os.path.realpath(PROMPTS_DIR)
    if rp.startswith(prompts_root + os.sep) and os.path.isfile(rp):
        return rp
    return default

# 同 basename（同一 session）并发运行守卫：审计一轮可达 10 分钟且所有产物
# （smart-agent-<basename>.jsonl / *-analysis.json / subagents/）按 basename 共享，
# 并发第二轮会交错撕裂日志行、后完成者覆盖前一轮报告（2026-08-27 实测两次 UI
# 触发共写同一 jsonl 出现撕裂行 + analysis.json 被晚完成的一轮覆盖）。按
# output_basename 拒绝并发，第二轮直接 409。
RUNS_INFLIGHT: dict[str, float] = {}
RUNS_LOCK = threading.Lock()


def try_acquire_run(key: str) -> str | None:
    """占用成功返回 None；已被占用返回冲突提示（含已运行时长）。"""
    with RUNS_LOCK:
        started = RUNS_INFLIGHT.get(key)
        if started is not None:
            mins = (time.time() - started) / 60
            return (f"该 session 的上一轮审计仍在进行中（已运行约 {mins:.1f} 分钟），"
                    "请等待完成后再生成，避免日志互相覆盖")
        RUNS_INFLIGHT[key] = time.time()
        return None


def release_run(key: str) -> None:
    with RUNS_LOCK:
        RUNS_INFLIGHT.pop(key, None)


def _provider_from_req(req: dict) -> AIProviderConfig:
    """请求体 provider 段（{baseUrl, apiKey, model}）→ AIProviderConfig。"""
    pcfg = req["provider"]
    return AIProviderConfig(
        base_url=pcfg["baseUrl"],
        api_key=pcfg["apiKey"],
        model=pcfg["model"],
    )


class Handler(BaseHTTPRequestHandler):
    @staticmethod
    def _ca_v4(write_event, provider, prompt_md, ctx, agent_io):
        if not isinstance(agent_io, dict):
            write_event({"stage": "error", "msg": "v4 缺少 agentIo 字段"})
            return
        agent_count = len(agent_io.get("agents", []))
        write_event({"stage": "extract-start",
                     "msg": f"agent-IO 提取完成（{agent_count} 个 agent，确定性，由路由算好）"})
        write_event({"stage": "extract-done",
                     "msg": f"agent-IO 就绪：{agent_count} 个 agent",
                     "outputPath": os.path.join(ctx.output_dir, f"{ctx.output_basename}-agentio.json")})
        analyze_log_path = os.path.join(
            ctx.output_dir, f"smart-agent-{ctx.output_basename}.jsonl")
        analyze_logger = JsonlLogger(log_path=analyze_log_path, cwd=os.getcwd(), append=False)
        v4ctx = RunContext(output_dir=ctx.output_dir, output_basename=ctx.output_basename,
                           on_progress=ctx.on_progress, logger=analyze_logger,
                           mode="v4", agent_io=agent_io)
        try:
            result = run_analysis_pipeline("", prompt_md, provider, v4ctx)
            write_event({
                "stage": "result",
                "outputPath": result.output_path,
                "steps": result.steps,
                "analysis": result.analysis,
            })
        finally:
            analyze_logger.close()

    @staticmethod
    def _ca_compress(write_event, provider, trajectory_text,
                     compress_prompt_path, ctx):
        if ctx.mode == "claude":
            write_event({"stage": "compress-start", "msg": "确定性压缩（秒级，不依赖 LLM）…"})
            compressed_text = deterministic_compress(trajectory_text)
            compressed_path = os.path.join(ctx.output_dir, f"{ctx.output_basename}-compressed.md")
            Path(compressed_path).write_text(compressed_text, encoding="utf-8")
        else:
            compress_log_path = os.path.join(
                ctx.output_dir, f"smart-agent-{ctx.output_basename}-compress.jsonl")
            compress_logger = JsonlLogger(log_path=compress_log_path, cwd=os.getcwd())
            cctx = RunContext(output_dir=ctx.output_dir, output_basename=ctx.output_basename,
                              on_progress=ctx.on_progress, logger=compress_logger, mode=ctx.mode)
            try:
                compressed_path = compress_trajectory(
                    trajectory_text, provider, compress_prompt_path, cctx)
                compressed_text = Path(compressed_path).read_text(encoding="utf-8")
            finally:
                compress_logger.close()
        orig_size = len(trajectory_text.encode("utf-8"))
        comp_size = len(compressed_text.encode("utf-8"))
        ratio = (comp_size / orig_size * 100) if orig_size else 0
        write_event({
            "stage": "compress-done",
            "msg": f"压缩完成：{comp_size / 1024:.0f}KB ({ratio:.1f}%) → {compressed_path}",
            "outputPath": compressed_path,
        })
        return compressed_text

    @staticmethod
    def _ca_analyze(ctx, provider, prompt_md, trajectory_text, compressed_text):
        analyze_logger = JsonlLogger(
            log_path=os.path.join(ctx.output_dir, f"smart-agent-{ctx.output_basename}.jsonl"),
            cwd=os.getcwd())
        actx = RunContext(output_dir=ctx.output_dir, output_basename=ctx.output_basename,
                          on_progress=ctx.on_progress, logger=analyze_logger, mode=ctx.mode)
        try:
            result = run_analysis_pipeline(compressed_text, prompt_md, provider, actx)
            # 注入确定性提取的耗时/token 数据（不依赖 LLM，从原始轨迹提取）
            if result.analysis and isinstance(result.analysis, dict):
                result.analysis = inject_flow_metrics(result.analysis, trajectory_text)
            ctx.on_progress({
                "stage": "result",
                "outputPath": result.output_path,
                "steps": result.steps,
                "analysis": result.analysis,
            })
        finally:
            analyze_logger.close()

    def log_message(self, fmt, *args):
        # 简化日志，避免 stderr 噪音
        pass

    def _begin_ndjson_run(self, req: dict) -> tuple[str, object] | None:
        """按 outputBasename 占用并发守卫并开 NDJSON 流；冲突时已写 409 响应返回 None。"""
        run_key = _safe_output_basename(req.get("outputBasename", "session"))
        conflict = try_acquire_run(run_key)
        if conflict:
            self._json(409, {"error": conflict})
            return None
        return run_key, self._make_writer()

    def _write_stream_error(self, write_event, e: Exception) -> None:
        if isinstance(e, (AnalysisError, SchemaError)):
            write_event({"stage": "error", "msg": str(e)})
            return
        if isinstance(e, KeyError):
            write_event({"stage": "error", "msg": f"missing field: {e}"})
            return
        write_event({"stage": "error", "msg": f"{type(e).__name__}: {e}"})

    def _streamed(self, req: dict, run) -> None:
        """三个流式端点的公共骨架：占守卫 → 开 NDJSON → 执行闭包 → 错误入流 → 必释放。"""
        begun = self._begin_ndjson_run(req)
        if begun is None:
            return
        run_key, write_event = begun
        try:
            run(run_key, write_event)
        except Exception as e:
            self._write_stream_error(write_event, e)
        finally:
            release_run(run_key)

    def _do_post(self) -> None:
        if self.path == "/analyze":
            self._handle_analyze()
            return
        if self.path == "/compress":
            self._handle_compress()
            return
        if self.path == "/compress-and-analyze":
            self._handle_compress_and_analyze()
            return
        self._json(404, {"error": "not found"})

    do_POST = _do_post

    def _do_get(self) -> None:
        if self.path == "/health":
            # service 标识是启动器（bin/cannbot-insight.mjs 复用判定）与
            # scripts/pick-smart-agent-port.sh（杀旧重启判定）的正身依据：
            # 仅凭 2xx 无法区分 smart-agent 与任意带 /health 的无关服务
            self._json(200, {"status": "ok", "service": "cannbot-smart-agent"})
            return
        self._json(404, {"error": "not found"})

    do_GET = _do_get

    def _do_options(self) -> None:
        self.send_response(204)
        self._cors()
        self.end_headers()

    do_OPTIONS = _do_options

    def _handle_analyze(self) -> None:
        req = self._read_json_body()
        if req is None:
            return

        def run(run_key: str, write_event) -> None:
            trajectory_text = req["trajectoryText"]
            prompt_md = req.get("promptMd", "")
            output_dir = _confined_output_dir(req.get("outputDir"), os.path.join(os.getcwd(), "logs"))
            # Claude Code JSONL 日志：记录完整中间过程
            logger = JsonlLogger(
                log_path=os.path.join(output_dir, f"smart-agent-{run_key}.jsonl"),
                cwd=os.getcwd())
            ctx = RunContext(output_dir=output_dir, output_basename=run_key,
                             on_progress=write_event, logger=logger)
            result = run_analysis_pipeline(
                trajectory_text, prompt_md, _provider_from_req(req), ctx)
            write_event({
                "stage": "result",
                "outputPath": result.output_path,
                "steps": result.steps,
                "analysis": result.analysis,
            })

        self._streamed(req, run)

    def _handle_compress(self) -> None:
        req = self._read_json_body()
        if req is None:
            return

        def run(run_key: str, write_event) -> None:
            trajectory_text = req["trajectoryText"]
            output_dir = _confined_output_dir(req.get("outputDir"), os.path.join(os.getcwd(), "logs"))
            prompt_path = confined_prompt_path(req.get("promptPath"))
            logger = JsonlLogger(
                log_path=os.path.join(output_dir, f"smart-agent-{run_key}-compress.jsonl"),
                cwd=os.getcwd())
            ctx = RunContext(output_dir=output_dir, output_basename=run_key,
                             on_progress=write_event, logger=logger)
            compress_trajectory(trajectory_text, _provider_from_req(req), prompt_path, ctx)
            logger.close()

        self._streamed(req, run)

    def _handle_compress_and_analyze(self) -> None:
        req = self._read_json_body()
        if req is None:
            return

        def run(run_key: str, write_event) -> None:
            trajectory_text = req["trajectoryText"]
            prompt_md = req.get("promptMd", "")
            output_dir = _confined_output_dir(req.get("outputDir"), os.path.join(os.getcwd(), "tmp"))
            compress_prompt_path = confined_prompt_path(req.get("compressPromptPath"))
            provider = _provider_from_req(req)
            mode = req.get("mode", "agent")
            ctx = RunContext(output_dir=output_dir, output_basename=run_key,
                             on_progress=write_event, mode=mode)

            # v4：agent 中心三维度审计。不走压缩；agent-IO 已由 Next.js 路由确定性算好传入。
            if mode == "v4":
                self._ca_v4(write_event, provider, prompt_md, ctx, req.get("agentIo"))
                return

            # 阶段 1：压缩。claude 模式用确定性压缩（秒级，不依赖 LLM，
            # claude code 自带分析能力只需文件变小）；agent 模式用 LLM 压缩
            compressed_text = self._ca_compress(
                write_event, provider, trajectory_text, compress_prompt_path, ctx)

            # 阶段 2：分析（用压缩后文本）
            self._ca_analyze(ctx, provider, prompt_md, trajectory_text, compressed_text)

        self._streamed(req, run)

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length).decode("utf-8") if length else ""
        try:
            return json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            self._json(400, {"error": "invalid JSON body"})
            return None

    def _make_writer(self):
        # 流式响应头（NDJSON，逐行 flush）
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self._cors()
        self.end_headers()

        write_lock = threading.Lock()

        def write_event(obj: dict):
            line = json.dumps(obj, ensure_ascii=False) + "\n"
            with write_lock:
                try:
                    self.wfile.write(line.encode("utf-8"))
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass
        return write_event

    def _json(self, status: int, obj: dict):
        payload = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self._cors()
        self.end_headers()
        self.wfile.write(payload)

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")


if __name__ == "__main__":
    logging.basicConfig(stream=sys.stdout, format="%(message)s", level=logging.INFO)
    # 绑 127.0.0.1（与 next 一致）：localhost 后端服务不暴露到外部网卡——
    # 此前 0.0.0.0 全接口监听既不安全，也更容易与外部进程发生端口纠缠
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    logging.info(f"smart-agent server on http://localhost:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logging.info("\nshutting down")
        server.shutdown()
