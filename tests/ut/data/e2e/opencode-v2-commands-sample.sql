-- Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
-- This program is free software, you can redistribute it and/or modify it under the terms and conditions of
-- CANN Open Software License Agreement Version 2.0 (the "License").
-- Please refer to the License for details on how to use this file except in compliance with the License.
-- THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
-- INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
-- See LICENSE in the root of the software repository for the full text of the License.

-- opencode v2 (2.0.28) 命令面样本库 —— 结果负载归一 + shell 隐式读全链 IT 夹具。
-- 行形态镜像真机 2.0.28 会话（ses_ecb797cb 系）：
--   read 结果 = 内容块数组，text 为 "Read file …\nN: …" 行级文本（v2 `path` 参数键）
--   shell 命令 = {"command":"cat … && sed -n 5,9p …"}（v2 工具名 shell，冒号行号）
--   skill 结果 = 内容块数组 + <skill_content name="…"> 协议壳（v2 `id` 参数键）
-- 历史缺陷锁：内容块数组整体 stringify 落库 → read 行级解析 / 文件还原 /
-- skill 内容全链失效；shell 隐式读不采集 → Files 分析缺失。

PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE `session_v2` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`parent_id` text,
	`title` text,
	`version` text NOT NULL,
	`directory` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	`summary_additions` integer,
	`summary_deletions` integer,
	`summary_files` integer,
	`agent` text,
	`model` text
);
INSERT INTO session_v2 VALUES('ses_v2cmd001ffeV2SampleFff','global',NULL,'v2 command surfaces sample','2.0.28','/home/demo/cmdproj',1790000000000,1790000009000,8,2,3,NULL,'{"id":"model-a1","providerID":"gateway"}');

CREATE TABLE `session_message` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`type` text NOT NULL,
	`seq` integer NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	`data` text NOT NULL
);
INSERT INTO session_message VALUES('msg_v2c001','ses_v2cmd001ffeV2SampleFff','user',1,1790000000123,1790000000123,'{"time":{"created":1790000000123},"text":"check the skill and the source files","files":[]}');
INSERT INTO session_message VALUES('msg_v2c002','ses_v2cmd001ffeV2SampleFff','assistant',2,1790000000200,1790000004100,'{"time":{"created":1790000000200,"streamed":1790000004000,"completed":1790000004100},"agent":"build","model":{"id":"model-a1","providerID":"gateway"},"finish":"tool-calls","cost":0.02,"tokens":{"input":1500,"output":80,"reasoning":40,"cache":{"read":200,"write":0}},"content":[{"type":"reasoning","text":"Inspect the skill and files."},{"type":"text","text":"Let me inspect."},{"type":"tool","id":"call_r1","name":"read","executed":true,"state":{"status":"completed","input":{"path":"/home/demo/cmdproj/src/app.py"},"content":[{"type":"text","text":"Read file /home/demo/cmdproj/src/app.py, lines 1-4\n1: import os\n2: \n3: def main():\n4:     pass"}]},"time":{"created":1790000000300,"ran":1790000000400,"completed":1790000000500}},{"type":"tool","id":"call_s1","name":"shell","executed":true,"state":{"status":"completed","input":{"command":"cat /home/demo/cmdproj/a.txt && sed -n 5,9p /home/demo/cmdproj/b.txt"},"content":[{"type":"text","text":"a-contents\nb-contents"}]},"time":{"created":1790000000600,"ran":1790000000700,"completed":1790000000800}},{"type":"tool","id":"call_k1","name":"skill","executed":true,"state":{"status":"completed","input":{"id":"demo-v2-skill"},"content":[{"type":"text","text":"<skill_content name=\"demo-v2-skill\">\n# Demo V2 Skill\n\nSkill body line.\n</skill_content>"}]},"time":{"created":1790000000900,"ran":1790000001000,"completed":1790000001100}}]}');
INSERT INTO session_message VALUES('msg_v2c003','ses_v2cmd001ffeV2SampleFff','assistant',3,1790000005000,1790000006000,'{"time":{"created":1790000005000,"streamed":1790000005900,"completed":1790000006000},"agent":"build","model":{"id":"model-a1","providerID":"gateway"},"finish":"stop","cost":0.01,"tokens":{"input":900,"output":50,"reasoning":10,"cache":{"read":100,"write":0}},"content":[{"type":"text","text":"All checks done."}]}');
COMMIT;
