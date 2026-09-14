import assert from "node:assert/strict";
import { HeadTailBuffer, ProcessSessionManager } from "./process-sessions.js";

const smallBuffer = new HeadTailBuffer(100);
smallBuffer.append("hello\n");
assert.deepEqual(smallBuffer.drain(100), { output: "hello\n", truncated: false });
assert.deepEqual(smallBuffer.drain(100), { output: "", truncated: false });

const headTail = new HeadTailBuffer(10);
headTail.append("start-middle-end");
const headTailResult = headTail.drain(1_000);
assert.equal(headTailResult.truncated, true);
assert.match(headTailResult.output, /^start/);
assert.match(headTailResult.output, /e-end$/);
assert.match(headTailResult.output, /characters omitted/);

const responseLimited = new HeadTailBuffer(100);
responseLimited.append("abcdef".repeat(20));
const responseLimitedResult = responseLimited.drain(40);
assert.equal(responseLimitedResult.truncated, true);
assert.match(responseLimitedResult.output, /^abc/);
assert.match(responseLimitedResult.output, /def$/);

const unicodeBuffer = new HeadTailBuffer(4);
unicodeBuffer.append("a🙂b🙂c");
const unicodeResult = unicodeBuffer.drain(1_000);
assert.equal(unicodeResult.truncated, true);
assert.match(unicodeResult.output, /^a🙂/);
assert.match(unicodeResult.output, /🙂c$/);

const largeUnicodeBuffer = new HeadTailBuffer(1_000);
largeUnicodeBuffer.append("🙂".repeat(100_000));
const largeUnicodeResult = largeUnicodeBuffer.drain(1_000);
assert.equal(largeUnicodeResult.truncated, true);
for (let index = 0; index < largeUnicodeResult.output.length; index += 1) {
  const codeUnit = largeUnicodeResult.output.charCodeAt(index);
  if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
    const next = largeUnicodeResult.output.charCodeAt(index + 1);
    assert.ok(next >= 0xdc00 && next <= 0xdfff, "high surrogate must retain its low surrogate");
    index += 1;
  } else {
    assert.ok(
      codeUnit < 0xdc00 || codeUnit > 0xdfff,
      "low surrogate must not appear without its high surrogate",
    );
  }
}

const manager = new ProcessSessionManager({
  maxBufferCharacters: 1_024,
  completedSessionTtlMs: 1_000,
  maxConcurrentProcesses: 16,
});

const node = process.platform === "win32"
  ? `"${process.execPath}"`
  : JSON.stringify(process.execPath);

const foreground = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "console.log('foreground')"`,
  yieldTimeMs: 2_000,
});
assert.equal(foreground.running, false);
assert.equal(foreground.exitCode, 0);
assert.match(foreground.output, /foreground/);
assert.equal(foreground.sessionId, undefined);

const environment = await manager.start({
  workspaceId: "workspace-a",
  workspaceRoot: "/tmp/devspace-workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "console.log([process.env.NO_COLOR, process.env.TERM, process.env.PAGER, process.env.GIT_PAGER, process.env.GH_PAGER, process.env.CODEX_CI, process.env.DEVSPACE_WORKSPACE_ID, process.env.DEVSPACE_WORKSPACE_ROOT].join(','))"`,
  yieldTimeMs: 2_000,
});
assert.equal(environment.running, false);
assert.match(environment.output, /1,dumb,cat,cat,cat,1,workspace-a,\/tmp\/devspace-workspace-a/);

const background = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "setTimeout(() => console.log('finished'), 100)"`,
  yieldTimeMs: 5,
});
assert.equal(background.running, true);
assert.ok(background.sessionId);
assert.equal(typeof background.sessionId, "number");

await assert.rejects(
  manager.write({
    workspaceId: "workspace-b",
    sessionId: background.sessionId,
    yieldTimeMs: 1,
  }),
  /does not belong to workspace/,
);

const completed = await manager.write({
  workspaceId: "workspace-a",
  sessionId: background.sessionId,
  yieldTimeMs: 2_000,
});
assert.equal(completed.running, false);
assert.equal(completed.exitCode, 0);
assert.match(completed.output, /finished/);

const interactive = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "process.stdin.once('data', data => { console.log('input:' + data.toString().trim()); process.exit(0); })"`,
  yieldTimeMs: 5,
});
assert.equal(interactive.running, true);
assert.ok(interactive.sessionId);
assert.equal(typeof interactive.sessionId, "number");

const inputResult = await manager.write({
  workspaceId: "workspace-a",
  sessionId: interactive.sessionId,
  chars: "hello\n",
  yieldTimeMs: 2_000,
});
assert.equal(inputResult.running, false);
assert.match(inputResult.output, /input:hello/);

const defaultInteractive = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "process.stdin.once('data', data => setTimeout(() => { console.log('default-input:' + data.toString().trim()); process.exit(0); }, 25))"`,
  yieldTimeMs: 5,
});
assert.equal(defaultInteractive.running, true);
assert.ok(defaultInteractive.sessionId);

const defaultInputResult = await manager.write({
  workspaceId: "workspace-a",
  sessionId: defaultInteractive.sessionId,
  chars: "hello\n",
});
assert.equal(defaultInputResult.running, false);
assert.match(defaultInputResult.output, /default-input:hello/);

const noisyInteractive = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "setInterval(() => console.log('tick'), 10); process.stdin.once('data', data => { console.log('input:' + data.toString().trim()); process.exit(0); })"`,
  yieldTimeMs: 100,
});
assert.equal(noisyInteractive.running, true);
assert.ok(noisyInteractive.sessionId);

await new Promise((resolve) => setTimeout(resolve, 50));
const noisyInputResult = await manager.write({
  workspaceId: "workspace-a",
  sessionId: noisyInteractive.sessionId,
  chars: "hello\n",
  yieldTimeMs: 2_000,
});
assert.equal(noisyInputResult.running, false);
assert.match(noisyInputResult.output, /input:hello/);

const interruptible = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "setInterval(() => console.log('tick'), 10)"`,
  yieldTimeMs: 100,
});
assert.equal(interruptible.running, true);
assert.ok(interruptible.sessionId);

await new Promise((resolve) => setTimeout(resolve, 50));
const interrupted = await manager.write({
  workspaceId: "workspace-a",
  sessionId: interruptible.sessionId,
  chars: "\u0003",
  yieldTimeMs: 2_000,
});
assert.equal(interrupted.running, false);
if (process.platform !== "win32") assert.equal(interrupted.signal, "SIGINT");

let buffered = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "console.log('x'.repeat(5000)); setTimeout(() => {}, 100)"`,
  yieldTimeMs: 50,
  maxOutputTokens: 100,
});
if (!buffered.outputTruncated && buffered.sessionId) {
  buffered = await manager.write({
    workspaceId: "workspace-a",
    sessionId: buffered.sessionId,
    yieldTimeMs: 2_000,
    maxOutputTokens: 100,
  });
}
assert.equal(buffered.outputTruncated, true);
if (buffered.sessionId) manager.terminate("workspace-a", buffered.sessionId);

try {
  if (process.platform === "win32") {
    const pty = await manager.start({
      workspaceId: "workspace-a",
      cwd: process.cwd(),
      command: "echo pty-ok",
      tty: true,
      yieldTimeMs: 10_000,
    });
    assert.equal(pty.running, false);
    assert.match(pty.output, /pty-ok/);
  } else {
    const pty = await manager.start({
      workspaceId: "workspace-a",
      cwd: process.cwd(),
      command: `${node} -e "setTimeout(() => console.log('columns:' + process.stdout.columns), 250)"`,
      tty: true,
      columns: 80,
      rows: 24,
      yieldTimeMs: 10,
    });
    assert.equal(pty.running, true);
    assert.ok(pty.sessionId);

    const resizedPty = await manager.write({
      workspaceId: "workspace-a",
      sessionId: pty.sessionId,
      columns: 120,
      rows: 30,
      yieldTimeMs: 2_000,
    });
    assert.equal(resizedPty.running, false);
    assert.match(resizedPty.output, /columns:120/);
  }
} finally {
  manager.shutdown();
}

const limitedManager = new ProcessSessionManager({
  maxConcurrentProcesses: 1,
  maxConcurrentProcessesPerWorkspace: 1,
  maxSessions: 2,
  maxBufferCharacters: 1_024,
});
try {
  const held = await limitedManager.start({
    workspaceId: "workspace-a",
    cwd: process.cwd(),
    command: `${node} -e "setInterval(() => {}, 1000)"`,
    yieldTimeMs: 5,
  });
  assert.equal(held.running, true);
  assert.ok(held.sessionId);
  assert.equal(limitedManager.stats.active, 1);
  await assert.rejects(
    limitedManager.start({
      workspaceId: "workspace-a",
      cwd: process.cwd(),
      command: `${node} -e "console.log('should-not-run')"`,
      yieldTimeMs: 100,
    }),
    /Concurrent process limit reached \(1\)/,
  );
  limitedManager.terminate("workspace-a", held.sessionId);
} finally {
  limitedManager.shutdown();
}

const fairManager = new ProcessSessionManager({
  maxConcurrentProcesses: 3,
  maxConcurrentProcessesPerWorkspace: 1,
  maxSessions: 4,
  maxBufferCharacters: 1_024,
});
try {
  const firstWorkspace = await fairManager.start({
    workspaceId: "workspace-a",
    cwd: process.cwd(),
    command: `${node} -e "setInterval(() => {}, 1000)"`,
    yieldTimeMs: 5,
  });
  assert.equal(firstWorkspace.running, true);
  await assert.rejects(
    fairManager.start({
      workspaceId: "workspace-a",
      cwd: process.cwd(),
      command: `${node} -e "console.log('same-workspace-should-not-run')"`,
      yieldTimeMs: 100,
    }),
    /Concurrent process limit reached for workspace workspace-a \(1\)/,
  );

  const secondWorkspace = await fairManager.start({
    workspaceId: "workspace-b",
    cwd: process.cwd(),
    command: `${node} -e "setInterval(() => {}, 1000)"`,
    yieldTimeMs: 5,
  });
  assert.equal(secondWorkspace.running, true);
  assert.deepEqual(fairManager.stats, {
    total: 2,
    active: 2,
    maxConcurrent: 3,
    maxConcurrentPerWorkspace: 1,
    maxSessions: 4,
  });
  fairManager.terminate("workspace-a", firstWorkspace.sessionId!);
  fairManager.terminate("workspace-b", secondWorkspace.sessionId!);
} finally {
  fairManager.shutdown();
}

const retainedManager = new ProcessSessionManager({
  maxConcurrentProcesses: 1,
  maxSessions: 1,
  maxBufferCharacters: 1_024,
  completedSessionTtlMs: 10_000,
});
try {
  const retained = await retainedManager.start({
    workspaceId: "workspace-a",
    cwd: process.cwd(),
    command: `${node} -e "setTimeout(() => console.log('retained'), 20)"`,
    yieldTimeMs: 1,
  });
  assert.equal(retained.running, true);
  assert.ok(retained.sessionId);
  // Leave enough wall-clock room for the child Node process itself to start
  // under a loaded full-suite run before its 20 ms timer fires. This test is
  // about completed-session capacity eviction, not process startup latency.
  await new Promise((resolve) => setTimeout(resolve, 500));

  const replacement = await retainedManager.start({
    workspaceId: "workspace-a",
    cwd: process.cwd(),
    command: `${node} -e "console.log('replacement')"`,
    yieldTimeMs: 2_000,
  });
  assert.equal(replacement.running, false);
  assert.match(replacement.output, /replacement/);
  await assert.rejects(
    retainedManager.write({
      workspaceId: "workspace-a",
      sessionId: retained.sessionId,
      yieldTimeMs: 1,
    }),
    /Unknown process session/,
  );
} finally {
  retainedManager.shutdown();
}

assert.throws(
  () => new ProcessSessionManager({ maxConcurrentProcesses: 2, maxSessions: 1 }),
  /maxSessions must be an integer no smaller than maxConcurrentProcesses/,
);
assert.throws(
  () => new ProcessSessionManager({
    maxConcurrentProcesses: 2,
    maxConcurrentProcessesPerWorkspace: 3,
  }),
  /maxConcurrentProcessesPerWorkspace must be a positive integer no greater than maxConcurrentProcesses/,
);
