-- v1-only opencode 库：工具 part 时间戳采集 IT 夹具。
-- p_tt_tool1: completed 终态，time_created→time_updated = 真实执行 4000ms
-- p_tt_tool2: running 非终态，time_updated 不是完成时刻 → completedAt 应降级 null
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
CREATE TABLE `message` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	`data` text NOT NULL
);
CREATE TABLE `part` (
	`id` text PRIMARY KEY,
	`message_id` text NOT NULL,
	`session_id` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	`data` text NOT NULL
);
INSERT INTO session VALUES('ses_tooltim01ffeTimingAa','global',NULL,'tool timing session','1.18.31','/home/demo/proj',1792000000000,1792000020000);
INSERT INTO message VALUES('m_tt1','ses_tooltim01ffeTimingAa',1792000000000,1792000000000,'{"role":"user","time":{"created":1792000000000}}');
INSERT INTO message VALUES('m_tt2','ses_tooltim01ffeTimingAa',1792000002000,1792000006000,'{"parentID":"m_tt1","role":"assistant","agent":"build","cost":0.01,"tokens":{"total":900,"input":800,"output":80,"reasoning":10,"cache":{"write":0,"read":0}},"modelID":"model-a1","providerID":"gateway","time":{"created":1792000002000,"completed":1792000006000},"finish":"stop"}');
INSERT INTO message VALUES('m_tt3','ses_tooltim01ffeTimingAa',1792000020000,1792000021000,'{"parentID":"m_tt1","role":"assistant","agent":"build","cost":0.01,"tokens":{"total":950,"input":850,"output":90,"reasoning":0,"cache":{"write":0,"read":0}},"modelID":"model-a1","providerID":"gateway","time":{"created":1792000020000,"completed":1792000021000},"finish":"stop"}');
INSERT INTO part VALUES('p_tt_txt1','m_tt2','ses_tooltim01ffeTimingAa',1792000006000,1792000006000,'{"type":"text","text":"跑两个探测工具"}');
INSERT INTO part VALUES('p_tt_tool1','m_tt2','ses_tooltim01ffeTimingAa',1792000006000,1792000010000,'{"type":"tool","tool":"bash","callID":"call_tt_op1","state":{"status":"completed","input":{"command":"sleep 4"},"output":"done"}}');
INSERT INTO part VALUES('p_tt_tool2','m_tt2','ses_tooltim01ffeTimingAa',1792000011000,1792000011500,'{"type":"tool","tool":"read","callID":"call_tt_op2","state":{"status":"running","input":{"path":"/tmp/x"}}}');
INSERT INTO part VALUES('p_tt_txt2','m_tt3','ses_tooltim01ffeTimingAa',1792000021000,1792000021000,'{"type":"text","text":"收尾"}');
