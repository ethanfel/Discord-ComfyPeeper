// Exercise an unmodified, pinned Vesktop release with the installed Peeper
// bundle. No Discord login, messages, uploads, or external ComfyUI requests.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

assert.equal(process.env.GITHUB_ACTIONS, "true", "Use an isolated CI runner");
const [binary, profile, electronProfile] = process.argv.slice(2);
assert.ok(binary && profile && electronProfile);
const child = spawn(binary, [
    `--user-data-dir=${electronProfile}`, "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1", "--disable-gpu", "--disable-speech-api",
    "--ozone-platform=x11", "--no-sandbox",
], { env: { ...process.env, VENCORD_USER_DATA_DIR: profile }, stdio: ["ignore", "pipe", "pipe"] });
// --no-sandbox is confined to this disposable CI test, never user installations.
let logs = "";
let socket;
let browserSocket;
let nextId = 0;
const pending = new Map();
child.on("error", error => { logs += String(error); });
for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", data => { logs = (logs + data).slice(-200000); });
}

async function connect(url) {
    const ws = new WebSocket(url);
    await Promise.race([once(ws, "open"), delay(10000).then(() => { throw Error("DevTools connection timeout"); })]);
    return ws;
}

function command(method, params = {}) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(Error(`Timed out: ${method}`)); }, 10000);
        pending.set(id, {
            resolve: value => { clearTimeout(timer); resolve(value); },
            reject: error => { clearTimeout(timer); reject(error); },
        });
        socket.send(JSON.stringify({ id, method, params }));
    });
}

try {
    const deadline = Date.now() + 90000;
    let browserUrl;
    while (Date.now() < deadline && !browserUrl) {
        assert.equal(child.exitCode, null, "Vesktop exited before DevTools started");
        browserUrl = logs.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/)?.[1];
        if (!browserUrl) await delay(250);
    }
    assert.ok(browserUrl, "Vesktop did not start DevTools");
    browserSocket = await connect(browserUrl);
    const origin = `http://${new URL(browserUrl).host}`;
    let last = {};
    while (Date.now() < deadline) {
        assert.equal(child.exitCode, null, "Vesktop exited before Peeper loaded");
        const targets = await (await fetch(`${origin}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
        const target = targets.find(item => item.type === "page" && /https:\/\/(?:\w+\.)?discord\.com\//.test(item.url));
        if (!target) { await delay(500); continue; }
        socket = await connect(target.webSocketDebuggerUrl);
        socket.addEventListener("message", event => {
            const message = JSON.parse(event.data);
            const request = pending.get(message.id);
            if (!request) return;
            pending.delete(message.id);
            if (message.error) request.reject(Error(message.error.message));
            else request.resolve(message.result);
        });
        const probe = await command("Runtime.evaluate", {
            expression: `({ plugin: !!globalThis.Vencord?.Plugins?.plugins?.ComfyPeeper,
                enabled: !!globalThis.Vencord?.Settings?.plugins?.ComfyPeeper?.enabled,
                native: typeof globalThis.VencordNative?.pluginHelpers?.ComfyPeeper?.fetchWorkflow === "function" })`,
            returnByValue: true,
        });
        last = probe.result?.value || {};
        if (last.plugin && last.enabled && last.native) break;
        socket.close();
        socket = undefined;
        await delay(500);
    }
    assert.ok(last.plugin && last.enabled && last.native, `Peeper did not load: ${JSON.stringify(last)}`);
    const fixture = { last_node_id: 1, last_link_id: 0, nodes: [{ id: 1, type: "EmptyLatentImage" }], links: [], version: 0.4 };
    const url = "data:application/json," + encodeURIComponent(JSON.stringify(fixture));
    const result = await command("Runtime.evaluate", {
        expression: `VencordNative.pluginHelpers.ComfyPeeper.fetchWorkflow(${JSON.stringify(url)}, 1048576, "json")`,
        awaitPromise: true, returnByValue: true,
    });
    assert.equal(result.exceptionDetails, undefined, "Native IPC invocation failed");
    assert.equal(result.result.value.ok, true);
    assert.deepEqual(JSON.parse(result.result.value.workflow), fixture);
    console.log("PASS: real Vesktop startup, custom bundle, enabled Peeper renderer, native IPC, workflow JSON parsing");
} catch (error) {
    console.error(logs);
    throw error;
} finally {
    socket?.close();
    if (child.exitCode === null && browserSocket?.readyState === WebSocket.OPEN) {
        browserSocket.send(JSON.stringify({ id: 999999, method: "Browser.close" }));
    }
    browserSocket?.close();
    if (child.exitCode === null) await Promise.race([once(child, "exit"), delay(5000)]);
    if (child.exitCode === null) {
        // Only the exact disposable process this test spawned is terminated.
        child.kill("SIGTERM");
        await Promise.race([once(child, "exit"), delay(5000)]);
    }
    if (child.exitCode === null && child.signalCode === null) {
        throw Error("The disposable Vesktop process did not exit; runner teardown will reclaim it");
    }
}
