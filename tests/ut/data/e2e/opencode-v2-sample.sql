-- Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
-- This program is free software: you can redistribute it and/or modify it under the terms and conditions of
-- CANN Open Software License Agreement Version 2.0 (the "License").
-- You may refer to the License for details on how to use this file in compliance with the License.
-- THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
-- INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
-- See LICENSE in the root of the software repository for the full text of the License.

-- opencode v2 (2.0.x) sample database — schema and row shapes mirror a real
-- opencode 2.0.18 database: sessions live in `session_v2` (title nullable),
-- messages are event-sourced rows in `session_message` (per-session `seq`,
-- tagged `type`, payload in `data`), tool calls are inlined in the assistant
-- content array. The v1 tables (session/message/part) do NOT exist in this
-- generation — that absence is the point of the fixture.
--
-- Sessions:
--   ses_v2main001ffeV2SampleAaa  main session, full type coverage
--   ses_v2sub001ffeV2SampleBbb   subagent session (parent_id + @agent title)
--   ses_v2fail001ffeV2SampleCcc  failed session (null title, user + idle only)

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
INSERT INTO session_v2 VALUES('ses_v2main001ffeV2SampleAaa','global',NULL,'Fix build failure in sample project','2.0.18','/home/demo/proj',1790000000000,1790000014000,12,3,2,NULL,'{"id":"model-a1","providerID":"gateway"}');
INSERT INTO session_v2 VALUES('ses_v2sub001ffeV2SampleBbb','global','ses_v2main001ffeV2SampleAaa','@(build) subagent: scan logs','2.0.18','/home/demo/proj',1790000009400,1790000010500,0,0,0,NULL,NULL);
INSERT INTO session_v2 VALUES('ses_v2fail001ffeV2SampleCcc','global',NULL,NULL,'2.0.18','/home/demo/proj',1790000020000,1790000020500,0,0,0,NULL,NULL);

CREATE TABLE `session_message` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`type` text NOT NULL,
	`seq` integer NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	`data` text NOT NULL
);

-- main session: user prompt
INSERT INTO session_message VALUES('msg_v2m004','ses_v2main001ffeV2SampleAaa','user',4,1790000000123,1790000000123,'{"time":{"created":1790000000123},"text":"Help me fix the build failure in sample project","files":[]}');
-- assistant with reasoning + text + completed skill tool invoke
INSERT INTO session_message VALUES('msg_v2m005','ses_v2main001ffeV2SampleAaa','assistant',5,1790000000200,1790000003100,'{"time":{"created":1790000000200,"streamed":1790000003000,"completed":1790000003100},"agent":"build","model":{"id":"model-a1","providerID":"gateway","variant":"default"},"finish":"tool-calls","cost":0.012,"tokens":{"input":1200,"output":45,"reasoning":30,"cache":{"read":300,"write":0}},"content":[{"type":"reasoning","text":"The user needs help fixing a build failure. I should look at the project structure first."},{"type":"text","text":"Let me inspect the project."},{"type":"tool","id":"call_skill_001","name":"skill","executed":true,"state":{"status":"completed","input":{"skill":"demo-skill"},"content":[{"type":"text","text":"Skill demo-skill loaded with 3 instructions"}]},"time":{"created":1790000000300,"ran":1790000000400,"completed":1790000000500}}]}');
-- assistant with an errored read tool
INSERT INTO session_message VALUES('msg_v2m006','ses_v2main001ffeV2SampleAaa','assistant',6,1790000004000,1790000005100,'{"time":{"created":1790000004000,"streamed":1790000005000,"completed":1790000005100},"agent":"build","model":{"id":"model-a1","providerID":"gateway"},"finish":"tool-calls","cost":0.008,"tokens":{"input":900,"output":60,"reasoning":25,"cache":{"read":500,"write":0}},"content":[{"type":"tool","id":"call_read_002","name":"read","state":{"status":"error","input":{"filePath":"missing.txt"},"error":{"message":"file not found: missing.txt"}},"time":{"created":1790000004200,"ran":1790000004300,"completed":1790000005000}}]}');
-- assistant final answer
INSERT INTO session_message VALUES('msg_v2m007','ses_v2main001ffeV2SampleAaa','assistant',7,1790000006000,1790000007000,'{"time":{"created":1790000006000,"streamed":1790000006900,"completed":1790000007000},"agent":"build","model":{"id":"model-a1","providerID":"gateway"},"finish":"stop","cost":0.005,"tokens":{"input":150,"output":80,"reasoning":10,"cache":{"read":800,"write":0}},"content":[{"type":"reasoning","text":"The file is missing, so the build cannot find it."},{"type":"text","text":"The build fails because missing.txt is referenced but does not exist."}]}');
-- system message (model-facing update)
INSERT INTO session_message VALUES('msg_v2m008','ses_v2main001ffeV2SampleAaa','system',8,1790000007500,1790000007500,'{"time":{"created":1790000007500},"text":"Environment switched to debug mode","description":"env switch"}');
-- compaction message (status completed)
INSERT INTO session_message VALUES('msg_v2m009','ses_v2main001ffeV2SampleAaa','compaction',9,1790000008000,1790000009000,'{"time":{"created":1790000008000,"completed":1790000009000},"status":"completed","reason":"auto","model":{"id":"model-a1","providerID":"gateway"},"summary":"Compacted summary: build failure context","recent":"recent context","tokens":{"input":500,"output":200,"reasoning":0,"cache":{"read":0,"write":0}},"cost":0.002}');
-- synthetic message
INSERT INTO session_message VALUES('msg_v2m010','ses_v2main001ffeV2SampleAaa','synthetic',10,1790000010000,1790000010000,'{"time":{"created":1790000010000},"text":"Subagent task completed, merging results","description":"task result"}');
-- skill context load message
INSERT INTO session_message VALUES('msg_v2m011','ses_v2main001ffeV2SampleAaa','skill',11,1790000011000,1790000011000,'{"time":{"created":1790000011000},"skill":"sk_demo","name":"demo-skill","text":"Contents of demo-skill SKILL.md body"}');
-- shell / agent-switched / model-switched / idle: control-plane, must be skipped
INSERT INTO session_message VALUES('msg_v2m012','ses_v2main001ffeV2SampleAaa','shell',12,1790000012000,1790000012500,'{"time":{"created":1790000012000,"completed":1790000012500},"shellID":"sh_1","command":"ls -la","status":"done","exit":0,"output":"total 0"}');
INSERT INTO session_message VALUES('msg_v2m013','ses_v2main001ffeV2SampleAaa','agent-switched',13,1790000013000,1790000013000,'{"time":{"created":1790000013000},"agent":"plan","previous":"build"}');
INSERT INTO session_message VALUES('msg_v2m014','ses_v2main001ffeV2SampleAaa','model-switched',14,1790000013500,1790000013500,'{"time":{"created":1790000013500},"model":{"id":"model-a2","providerID":"gateway"},"previous":{"id":"model-a1","providerID":"gateway"}}');
INSERT INTO session_message VALUES('msg_v2m015','ses_v2main001ffeV2SampleAaa','idle',15,1790000014000,1790000014000,'{"time":{"created":1790000014000},"outcome":"succeeded"}');

-- subagent session: user prompt + assistant with task tool (dispatch metadata
-- merge) and bash tool (completed)
INSERT INTO session_message VALUES('msg_v2s004','ses_v2sub001ffeV2SampleBbb','user',4,1790000009500,1790000009500,'{"time":{"created":1790000009500},"text":"Scan the build logs for errors","files":[]}');
INSERT INTO session_message VALUES('msg_v2s005','ses_v2sub001ffeV2SampleBbb','assistant',5,1790000009600,1790000010400,'{"time":{"created":1790000009600,"streamed":1790000010300,"completed":1790000010400},"agent":"build","model":{"id":"model-a1","providerID":"gateway"},"finish":"stop","cost":0.004,"tokens":{"input":400,"output":70,"reasoning":15,"cache":{"read":100,"write":0}},"content":[{"type":"text","text":"Scanning logs via nested agent and shell."},{"type":"tool","id":"call_task_101","name":"task","state":{"status":"completed","input":{"description":"nested scan"},"content":[{"type":"text","text":"nested subagent done"}],"metadata":{"sessionId":"ses_v2subsub001ffeV2SampleDdd","model":{"id":"model-a1","providerID":"gateway"}}},"time":{"created":1790000009700,"ran":1790000009800,"completed":1790000010100}},{"type":"tool","id":"call_bash_102","name":"bash","state":{"status":"completed","input":{"command":"grep -i error build.log"},"content":[{"type":"text","text":"error: missing.txt not found"}]},"time":{"created":1790000010200,"ran":1790000010250,"completed":1790000010300}}]}');

-- failed session: user prompt + idle(failed), no assistant rows, null title
INSERT INTO session_message VALUES('msg_v2f004','ses_v2fail001ffeV2SampleCcc','user',4,1790000020100,1790000020100,'{"time":{"created":1790000020100},"text":"This session will fail before the first response","files":[]}');
INSERT INTO session_message VALUES('msg_v2f005','ses_v2fail001ffeV2SampleCcc','idle',5,1790000020500,1790000020500,'{"time":{"created":1790000020500},"outcome":"failed"}');
COMMIT;
