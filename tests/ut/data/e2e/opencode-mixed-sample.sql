-- Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
-- This program is free software: you can redistribute it and/or modify it under the terms and conditions of
-- CANN Open Software License Agreement Version 2.0 (the "License").
-- You may refer to the License for details on how to use this file in compliance with the License.
-- THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
-- INCLUDING BUT NOT LIMITED TO WARRANTIES OF NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
-- See LICENSE in the root of the software repository for the full text of the License.

-- opencode mixed-generation sample database — mirrors a real machine where
-- opencode 2.x ran once (backfilling every 1.x session into session_v2 /
-- session_message, preserving original time_created) and the 1.x daily driver
-- kept writing to the v1 tables only. The v2 copies freeze at the backfill
-- moment; every message newer than that exists ONLY in v1 (measured on a real
-- 2.26GB db: an active session with 8 v1-only rows after the backfill cut).
--
-- Sessions (time base T = 1791000000000):
--   ses_mixmain001ffeMixedAaa  in both tables; v1 continues past the backfill
--                              (v1 max T+9000 > v2 max T+5000) → v1 reader
--   ses_mixtie001ffeMixedBbb   in both tables; identical max time (tie) plus a
--                              v1-only older row → v1 reader (tie → v1)
--   ses_mixv2only1ffeMixedCcc  only in session_v2 (written by 2.x) → v2 reader
--   ses_mixsub001ffeMixedDdd   subagent of mixmain, in both tables, v1 continues
--                              (v1 max T+6000 > v2 max T+4000) → v1 reader
--   ses_mixv1only1ffeMixedEee  only in session (1.x-created after the 2.x run)
--                              → v1 reader

PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE `session` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`parent_id` text,
	`title` text NOT NULL,
	`version` text NOT NULL,
	`directory` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
INSERT INTO session VALUES('ses_mixmain001ffeMixedAaa','global',NULL,'Mixed db main session','1.18.31','/home/demo/proj',1791000000000,1791000009000);
INSERT INTO session VALUES('ses_mixtie001ffeMixedBbb','global',NULL,'Mixed db tie session','1.18.31','/home/demo/proj',1791000000000,1791000003000);
INSERT INTO session VALUES('ses_mixsub001ffeMixedDdd','global','ses_mixmain001ffeMixedAaa','@(explore) subagent: check logs','1.18.31','/home/demo/proj',1791000003400,1791000006000);
INSERT INTO session VALUES('ses_mixv1only1ffeMixedEee','global',NULL,'v1-only session created after the 2.x run','1.18.31','/home/demo/proj',1791000009400,1791000009600);

CREATE TABLE `message` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	`data` text NOT NULL
);
-- main session: two backfilled turns + one post-backfill turn (v1-only)
INSERT INTO message VALUES('m_v1a1','ses_mixmain001ffeMixedAaa',1791000001000,1791000001000,'{"role":"user","time":{"created":1791000001000},"agent":"build","summary":{"diffs":[]}}');
INSERT INTO message VALUES('m_v1a2','ses_mixmain001ffeMixedAaa',1791000003000,1791000003200,'{"parentID":"m_v1a1","role":"assistant","mode":"build","agent":"build","cost":0.01,"tokens":{"total":900,"input":800,"output":80,"reasoning":20,"cache":{"write":0,"read":0}},"modelID":"model-a1","providerID":"gateway","time":{"created":1791000003000,"completed":1791000003200},"finish":"stop"}');
INSERT INTO message VALUES('m_v1a3','ses_mixmain001ffeMixedAaa',1791000005000,1791000005200,'{"parentID":"m_v1a1","role":"assistant","mode":"build","agent":"build","cost":0.01,"tokens":{"total":950,"input":850,"output":85,"reasoning":15,"cache":{"write":0,"read":0}},"modelID":"model-a1","providerID":"gateway","time":{"created":1791000005000,"completed":1791000005200},"finish":"stop"}');
INSERT INTO message VALUES('m_v1a4','ses_mixmain001ffeMixedAaa',1791000008000,1791000008000,'{"role":"user","time":{"created":1791000008000},"agent":"build","summary":{"diffs":[]}}');
INSERT INTO message VALUES('m_v1a5','ses_mixmain001ffeMixedAaa',1791000009000,1791000009000,'{"parentID":"m_v1a4","role":"assistant","mode":"build","agent":"build","cost":0.01,"tokens":{"total":990,"input":880,"output":90,"reasoning":20,"cache":{"write":0,"read":0}},"modelID":"model-a1","providerID":"gateway","time":{"created":1791000009000,"completed":1791000009000},"finish":"stop"}');
-- tie session: v1-only older row the backfill skipped + backfilled pair
INSERT INTO message VALUES('m_v1b0','ses_mixtie001ffeMixedBbb',1791000001000,1791000001000,'{"role":"user","time":{"created":1791000001000},"agent":"build","summary":{"diffs":[]}}');
INSERT INTO message VALUES('m_v1b1','ses_mixtie001ffeMixedBbb',1791000002000,1791000002000,'{"role":"user","time":{"created":1791000002000},"agent":"build","summary":{"diffs":[]}}');
INSERT INTO message VALUES('m_v1b2','ses_mixtie001ffeMixedBbb',1791000003000,1791000003000,'{"parentID":"m_v1b1","role":"assistant","mode":"build","agent":"build","cost":0.01,"tokens":{"total":800,"input":700,"output":80,"reasoning":20,"cache":{"write":0,"read":0}},"modelID":"model-a1","providerID":"gateway","time":{"created":1791000003000,"completed":1791000003000},"finish":"stop"}');
-- subagent session: backfilled pair + post-backfill reply (v1-only)
INSERT INTO message VALUES('m_v1d1','ses_mixsub001ffeMixedDdd',1791000003500,1791000003500,'{"role":"user","time":{"created":1791000003500},"agent":"build","summary":{"diffs":[]}}');
INSERT INTO message VALUES('m_v1d2','ses_mixsub001ffeMixedDdd',1791000004000,1791000004000,'{"parentID":"m_v1d1","role":"assistant","mode":"build","agent":"build","cost":0.01,"tokens":{"total":600,"input":500,"output":80,"reasoning":20,"cache":{"write":0,"read":0}},"modelID":"model-a1","providerID":"gateway","time":{"created":1791000004000,"completed":1791000004000},"finish":"stop"}');
INSERT INTO message VALUES('m_v1d3','ses_mixsub001ffeMixedDdd',1791000006000,1791000006000,'{"parentID":"m_v1d1","role":"assistant","mode":"build","agent":"build","cost":0.01,"tokens":{"total":660,"input":550,"output":90,"reasoning":20,"cache":{"write":0,"read":0}},"modelID":"model-a1","providerID":"gateway","time":{"created":1791000006000,"completed":1791000006000},"finish":"stop"}');
-- v1-only session (created after the 2.x run)
INSERT INTO message VALUES('m_v1e1','ses_mixv1only1ffeMixedEee',1791000009500,1791000009500,'{"role":"user","time":{"created":1791000009500},"agent":"build","summary":{"diffs":[]}}');
INSERT INTO message VALUES('m_v1e2','ses_mixv1only1ffeMixedEee',1791000009600,1791000009600,'{"parentID":"m_v1e1","role":"assistant","mode":"build","agent":"build","cost":0.01,"tokens":{"total":700,"input":600,"output":80,"reasoning":20,"cache":{"write":0,"read":0}},"modelID":"model-a1","providerID":"gateway","time":{"created":1791000009600,"completed":1791000009600},"finish":"stop"}');

CREATE TABLE `part` (
	`id` text PRIMARY KEY,
	`message_id` text NOT NULL,
	`session_id` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	`data` text NOT NULL
);
-- main session v1 content (differs from the v2 copy markers on purpose:
-- which string surfaces proves which table the reader used)
INSERT INTO part VALUES('p_v1a1','m_v1a1','ses_mixmain001ffeMixedAaa',1791000001000,1791000001000,'{"type":"text","text":"Shared prompt: fix the mixed-schema build"}');
INSERT INTO part VALUES('p_v1a2','m_v1a2','ses_mixmain001ffeMixedAaa',1791000003000,1791000003000,'{"type":"text","text":"v1 backfilled reply at T+3000"}');
INSERT INTO part VALUES('p_v1a3','m_v1a3','ses_mixmain001ffeMixedAaa',1791000005000,1791000005000,'{"type":"text","text":"v1 backfilled reply at T+5000"}');
INSERT INTO part VALUES('p_v1a4','m_v1a4','ses_mixmain001ffeMixedAaa',1791000008000,1791000008000,'{"type":"text","text":"Post-backfill question written by 1.x only"}');
INSERT INTO part VALUES('p_v1a5','m_v1a5','ses_mixmain001ffeMixedAaa',1791000009000,1791000009000,'{"type":"text","text":"Post-backfill v1 answer at T+9000"}');
INSERT INTO part VALUES('p_v1b0','m_v1b0','ses_mixtie001ffeMixedBbb',1791000001000,1791000001000,'{"type":"text","text":"v1-only intro that the backfill skipped"}');
INSERT INTO part VALUES('p_v1b1','m_v1b1','ses_mixtie001ffeMixedBbb',1791000002000,1791000002000,'{"type":"text","text":"Tie session second question"}');
INSERT INTO part VALUES('p_v1b2','m_v1b2','ses_mixtie001ffeMixedBbb',1791000003000,1791000003000,'{"type":"text","text":"v1 tie reply"}');
INSERT INTO part VALUES('p_v1d1','m_v1d1','ses_mixsub001ffeMixedDdd',1791000003500,1791000003500,'{"type":"text","text":"Scan the mixed logs"}');
INSERT INTO part VALUES('p_v1d2','m_v1d2','ses_mixsub001ffeMixedDdd',1791000004000,1791000004000,'{"type":"text","text":"v1 subagent backfilled reply"}');
INSERT INTO part VALUES('p_v1d3','m_v1d3','ses_mixsub001ffeMixedDdd',1791000006000,1791000006000,'{"type":"text","text":"v1 subagent post-backfill reply"}');
INSERT INTO part VALUES('p_v1e1','m_v1e1','ses_mixv1only1ffeMixedEee',1791000009500,1791000009500,'{"type":"text","text":"Fresh 1.x session after the 2.x run"}');
INSERT INTO part VALUES('p_v1e2','m_v1e2','ses_mixv1only1ffeMixedEee',1791000009600,1791000009600,'{"type":"text","text":"v1-only session reply"}');

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
-- backfilled rows keep the original session identity (title drift on the v2
-- copies marks which table a read came from); the v2-only row is a genuine
-- 2.x-written session
INSERT INTO session_v2 VALUES('ses_mixmain001ffeMixedAaa','global',NULL,'Mixed db main session (v2 copy)','1.18.31','/home/demo/proj',1791000000000,1791000005000,0,0,0,NULL,NULL);
INSERT INTO session_v2 VALUES('ses_mixtie001ffeMixedBbb','global',NULL,'Mixed db tie session','1.18.31','/home/demo/proj',1791000000000,1791000003000,0,0,0,NULL,NULL);
INSERT INTO session_v2 VALUES('ses_mixv2only1ffeMixedCcc','global',NULL,'Pure 2.x session','2.0.18','/home/demo/proj',1791000001000,1791000002500,0,0,0,NULL,NULL);
INSERT INTO session_v2 VALUES('ses_mixsub001ffeMixedDdd','global','ses_mixmain001ffeMixedAaa','@(explore) subagent: check logs','1.18.31','/home/demo/proj',1791000003400,1791000004000,0,0,0,NULL,NULL);

CREATE TABLE `session_message` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`type` text NOT NULL,
	`seq` integer NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	`data` text NOT NULL
);
-- main session v2 copy: freezes at the backfill moment (T+5000)
INSERT INTO session_message VALUES('msg_v2a1','ses_mixmain001ffeMixedAaa','user',1,1791000001000,1791000001000,'{"time":{"created":1791000001000},"text":"Shared prompt: fix the mixed-schema build","files":[]}');
INSERT INTO session_message VALUES('msg_v2a2','ses_mixmain001ffeMixedAaa','assistant',2,1791000003000,1791000003200,'{"time":{"created":1791000003000,"completed":1791000003200},"agent":"build","model":{"id":"model-a1","providerID":"gateway"},"finish":"stop","cost":0.01,"tokens":{"input":800,"output":80,"reasoning":20,"cache":{"read":0,"write":0}},"content":[{"type":"text","text":"v2 backfilled reply at T+3000"}]}');
INSERT INTO session_message VALUES('msg_v2a3','ses_mixmain001ffeMixedAaa','assistant',3,1791000005000,1791000005200,'{"time":{"created":1791000005000,"completed":1791000005200},"agent":"build","model":{"id":"model-a1","providerID":"gateway"},"finish":"stop","cost":0.01,"tokens":{"input":850,"output":85,"reasoning":15,"cache":{"read":0,"write":0}},"content":[{"type":"text","text":"v2 backfilled reply at T+5000"}]}');
-- tie session v2 copy: same max time as v1 (backfill preserved timestamps)
INSERT INTO session_message VALUES('msg_v2b1','ses_mixtie001ffeMixedBbb','user',1,1791000002000,1791000002000,'{"time":{"created":1791000002000},"text":"Tie session second question","files":[]}');
INSERT INTO session_message VALUES('msg_v2b2','ses_mixtie001ffeMixedBbb','assistant',2,1791000003000,1791000003000,'{"time":{"created":1791000003000,"completed":1791000003000},"agent":"build","model":{"id":"model-a1","providerID":"gateway"},"finish":"stop","cost":0.01,"tokens":{"input":700,"output":80,"reasoning":20,"cache":{"read":0,"write":0}},"content":[{"type":"text","text":"v2 tie reply"}]}');
-- pure 2.x session (v2 reader territory)
INSERT INTO session_message VALUES('msg_v2c1','ses_mixv2only1ffeMixedCcc','user',1,1791000001000,1791000001000,'{"time":{"created":1791000001000},"text":"Question asked inside pure 2.x","files":[]}');
INSERT INTO session_message VALUES('msg_v2c2','ses_mixv2only1ffeMixedCcc','assistant',2,1791000002000,1791000002000,'{"time":{"created":1791000002000,"completed":1791000002000},"agent":"build","model":{"id":"model-a1","providerID":"gateway"},"finish":"stop","cost":0.01,"tokens":{"input":500,"output":70,"reasoning":10,"cache":{"read":0,"write":0}},"content":[{"type":"text","text":"v2-only session reply"}]}');
INSERT INTO session_message VALUES('msg_v2c3','ses_mixv2only1ffeMixedCcc','idle',3,1791000002500,1791000002500,'{"time":{"created":1791000002500},"outcome":"succeeded"}');
-- subagent v2 copy: freezes at T+4000
INSERT INTO session_message VALUES('msg_v2d1','ses_mixsub001ffeMixedDdd','user',1,1791000003500,1791000003500,'{"time":{"created":1791000003500},"text":"Scan the mixed logs","files":[]}');
INSERT INTO session_message VALUES('msg_v2d2','ses_mixsub001ffeMixedDdd','assistant',2,1791000004000,1791000004000,'{"time":{"created":1791000004000,"completed":1791000004000},"agent":"build","model":{"id":"model-a1","providerID":"gateway"},"finish":"stop","cost":0.01,"tokens":{"input":500,"output":80,"reasoning":20,"cache":{"read":0,"write":0}},"content":[{"type":"text","text":"v2 subagent backfilled reply"}]}');
COMMIT;
