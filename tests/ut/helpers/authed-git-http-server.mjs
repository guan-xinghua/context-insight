// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 测试专用 git smart-http 网关：强制 Basic 认证（401 挑战-应答），鉴权通过后
// 委托 git http-backend 提供真实 git http 服务。作为独立子进程运行——消费方
// （insight 路由）经 execSync 同步执行 git，若网关与其同进程会死锁（事件循环
// 被同步调用冻结，回包永远发不出去）。用法：
//   node authed-git-http-server.mjs <docroot> <authlog> <user> <pass>
// 就绪后向 stdout 打印 "PORT=<n>"；每次收到的 Authorization 头追加写入 authlog
//（JSON lines），供测试断言「凭据确实经一次性 helper 送到了网关」。
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [docroot, authlog, user, pass] = process.argv.slice(2);
const expected = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

const server = http.createServer((req, res) => {
  const auth = req.headers.authorization ?? '';
  fs.appendFileSync(authlog, `${JSON.stringify({ ts: Date.now(), auth })}\n`);
  if (auth !== expected) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="cannbay-it"' });
    res.end('auth required');
    return;
  }
  const u = new URL(req.url, 'http://127.0.0.1');
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const child = spawn('git', ['http-backend'], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: docroot,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: u.pathname,
        REQUEST_METHOD: req.method,
        QUERY_STRING: u.searchParams.toString(),
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        REMOTE_USER: user,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = Buffer.alloc(0);
    let err = Buffer.alloc(0);
    child.stdout.on('data', c => { out = Buffer.concat([out, c]); });
    child.stderr.on('data', c => { err = Buffer.concat([err, c]); });
    child.on('error', e => {
      res.writeHead(500);
      res.end(String(e));
    });
    child.on('close', () => {
      const sep = out.indexOf('\r\n\r\n');
      if (sep < 0) {
        res.writeHead(500);
        res.end(`bad cgi response: ${err.toString().slice(0, 200)}`);
        return;
      }
      let status = 200;
      const headers = {};
      for (const line of out.slice(0, sep).toString().split('\r\n')) {
        const m = line.match(/^([^:]+):\s*(.*)$/);
        if (!m) continue;
        if (m[1].toLowerCase() === 'status') status = parseInt(m[2], 10);
        else headers[m[1]] = m[2];
      }
      res.writeHead(status, headers);
      res.end(out.slice(sep + 4));
    });
    for (const c of chunks) child.stdin.write(c);
    child.stdin.end();
  });
});

fs.mkdirSync(path.dirname(authlog), { recursive: true });
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`PORT=${server.address().port}\n`);
});
