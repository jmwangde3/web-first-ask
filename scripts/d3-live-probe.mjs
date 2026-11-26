// D3 live probe (2026-11-26, branch fix/d3-upload-investigate).
//
// Replays ONLY the Gemini upload steps against an already-open, logged-in
// Gemini tab on the Windows machine: buildUploadJs clicks ->
// DOM.setFileInputFiles -> immediate input dump + chip dump -> verify.
// It never types a prompt and never submits; the attached chip is left in
// the composer (refresh the tab to discard it).
//
// Run while the broker is STOPPED and the user's Chrome (the one holding
// the profile) is running with remote debugging on the port recorded in
// browser.lock (actualDebugPort):
//
//   node scripts/d3-live-probe.mjs --port 4040 --file H:\path\d3-attachment.txt
//
// Prints one JSON object to stdout. Exit 0 even when the upload fails —
// the failure IS the evidence; read the fields, do not re-run blindly.
// Exit 1 only when the probe itself could not attach (no Gemini tab,
// wrong port, Chrome not reachable).
//
// What each field settles (see docs/backlog.md D3):
// - setter.ok / setter.nodePath: did DOM.setFileInputFiles succeed, and on
//   which element (nodeId vs backendNodeId fallback)?
// - immediate.inputs[].files: files in each matching input the moment the
//   setter returned. [] here + verify failing = setter did not land (or
//   React cleared within milliseconds — see changeEvents).
// - immediate.changeEvents: did the input fire a `change` event for the
//   setter? Empty + files present = React never heard about the upload.
// - immediate.chips: outerHTML of every element the chip selector matches.
//   A chip with no filename text is an empty shell / always-present wrapper.
// - verifyImmediate / verifyAfter2s: the same diag attachFiles polls on.

import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as geminiAdapter from "../src/browser/adapters/gemini.js";
import { connectCdp } from "../src/browser/cdp.js";
import { listPageTargets } from "../src/browser/driver.js";

function parseArgs(argv) {
  const out = { port: 9222, file: null, urlSubstr: "gemini.google.com/app" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--port") out.port = Number(argv[i + 1]);
    if (argv[i] === "--file") out.file = argv[i + 1];
    if (argv[i] === "--url") out.urlSubstr = argv[i + 1];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.file) {
  console.error("usage: node scripts/d3-live-probe.mjs --port <n> --file <absolute-path>");
  process.exit(1);
}
const file = path.resolve(args.file);
const selector = geminiAdapter.fileInputSelector;
const chipSelector = geminiAdapter.attachmentChipSelector;

const fail = (message, extra = {}) => {
  console.log(JSON.stringify({ ok: false, error: message, ...extra }, null, 2));
  process.exit(1);
};

const cdp = await connectCdp(args.port).catch((err) => fail(`connectCdp failed: ${err?.message || err}`));
try {
  const targets = await listPageTargets(cdp).catch((err) => fail(`Target.getTargets failed: ${err?.message || err}`));
  const target = targets.find((t) => String(t?.url || "").includes(args.urlSubstr));
  if (!target) {
    fail("no Gemini app tab found", {
      urlSubstr: args.urlSubstr,
      pageUrls: targets.map((t) => t?.url || null).slice(0, 10),
    });
  }

  const attach = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  const sessionId = attach?.sessionId;
  if (!sessionId) fail("Target.attachToTarget returned no sessionId", { targetId: target.targetId });

  const evaluate = async (expression) => {
    try {
      const res = await cdp.send("Runtime.evaluate", {
        expression, returnByValue: true, awaitPromise: true,
      }, sessionId);
      if (res?.exceptionDetails) return { __error: res.exceptionDetails?.exception?.description || "evaluate exception" };
      return res?.result?.value ?? null;
    } catch (err) {
      return { __error: err?.message || String(err) };
    }
  };

  // 1. Upload prep: click trigger -> menu item -> wait for the file input.
  const uploadPrep = await evaluate(geminiAdapter.buildUploadJs());

  // 2. Change listener on every matching input, plus the pre-setter dump.
  //    Installed AFTER buildUploadJs so it targets the input the menu click
  //    just created, not a stale one from an earlier attempt.
  const inputsBefore = await evaluate(`(() => {
    const inputs = [...document.querySelectorAll(${JSON.stringify(selector)})];
    window.__d3probe = { changeEvents: [] };
    for (const input of inputs) {
      input.addEventListener("change", () => {
        window.__d3probe.changeEvents.push({ at: Date.now(), files: [...input.files].map((f) => f.name) });
      });
    }
    return inputs.map((input, i) => ({
      index: i, accept: input.accept || null,
      files: [...input.files].map((f) => f.name), connected: input.isConnected,
    }));
  })()`);

  // 3. Setter: same lookup order as driver.attachFiles (nodeId, then
  //    backendNodeId fallback via Runtime.evaluate + DOM.describeNode).
  let setter = { ok: false, nodePath: null, nodeId: null, backendNodeId: null, error: null };
  let fileNodeId = null;
  let backendNodeId = null;
  try {
    const doc = await cdp.send("DOM.getDocument", { depth: 0 }, sessionId);
    if (doc?.root?.nodeId) {
      const queryRes = await cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector }, sessionId);
      if (queryRes?.nodeId) fileNodeId = queryRes.nodeId;
    }
    if (!fileNodeId) {
      const evalNode = await cdp.send("Runtime.evaluate", {
        expression: `document.querySelector(${JSON.stringify(selector)})`,
      }, sessionId);
      const objectId = evalNode?.result?.objectId;
      if (objectId) {
        const desc = await cdp.send("DOM.describeNode", { objectId }, sessionId);
        backendNodeId = desc?.node?.backendNodeId ?? null;
      }
    }
    if (fileNodeId) {
      await cdp.send("DOM.setFileInputFiles", { files: [file], nodeId: fileNodeId }, sessionId);
      setter = { ok: true, nodePath: "nodeId", nodeId: fileNodeId, backendNodeId: null, error: null };
    } else if (backendNodeId) {
      await cdp.send("DOM.setFileInputFiles", { files: [file], backendNodeId }, sessionId);
      setter = { ok: true, nodePath: "backendNodeId", nodeId: null, backendNodeId, error: null };
    } else {
      setter = { ok: false, nodePath: null, nodeId: null, backendNodeId: null, error: "file input element not found" };
    }
  } catch (err) {
    setter = {
      ok: false, nodePath: fileNodeId ? "nodeId" : "backendNodeId",
      nodeId: fileNodeId, backendNodeId,
      error: err?.message || String(err),
    };
  }

  // 4. Immediately after the setter: all matching inputs, change events,
  //    chip subtree, and the same verify diag attachFiles polls on.
  const dumpInputsAndChips = `(() => {
    const inputs = [...document.querySelectorAll(${JSON.stringify(selector)})].map((input, i) => ({
      index: i, accept: input.accept || null,
      files: [...input.files].map((f) => ({ name: f.name, size: f.size })),
      connected: input.isConnected,
    }));
    const chips = [...document.querySelectorAll(${JSON.stringify(chipSelector)})]
      .map((el) => (el.outerHTML || "").slice(0, 2000));
    return {
      inputs, chips, chipCount: chips.length,
      changeEvents: window.__d3probe ? window.__d3probe.changeEvents : null,
    };
  })()`;
  const immediate = await evaluate(dumpInputsAndChips);
  const verifyImmediate = await evaluate(geminiAdapter.buildAttachmentVerifyJs([file]));

  // 5. Same again after 2 s: a chip that only appears late, or a file the
  //    page reads asynchronously, shows up here.
  await sleep(2000);
  const after2s = await evaluate(dumpInputsAndChips);
  const verifyAfter2s = await evaluate(geminiAdapter.buildAttachmentVerifyJs([file]));

  console.log(JSON.stringify({
    ok: true,
    file,
    targetUrl: target.url,
    uploadPrep,
    inputsBefore,
    setter,
    immediate,
    verifyImmediate,
    after2s,
    verifyAfter2s,
  }, null, 2));
} finally {
  cdp.close();
}
