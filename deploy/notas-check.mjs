// SPDX-License-Identifier: AGPL-3.0-or-later
// Epigrapho (A5): checks shared notes against a local stack, the same one
// marketing-consent-check.mjs needs (MongoDB, Identity, Notesnook.API and
// Messenger with SELF_HOSTED=1 and S3_SERVICE_URL=http://localhost:9000).
// This script serves the empty S3 itself.
//
// Checks that:
//   1. a note publishes and reads back by its slug;
//   2. the view count is there without a Pro plan, and a view counts;
//   3. a note that reads itself away is gone after its first view;
//   4. a note over 10 MB is refused with a clear error.
//
//   node deploy/notas-check.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";

const API = "http://localhost:5264";
const s3 = createServer((req, res) => {
  res.setHeader("Content-Type", "application/xml");
  res.end(
    '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>attachments</Name><KeyCount>0</KeyCount><IsTruncated>false</IsTruncated></ListBucketResult>'
  );
})
  // Another stand-in may already be serving 9000; that one will do.
  .on("error", () => {})
  .listen(9000);

const id = () => Math.random().toString(16).slice(2).padEnd(24, "0").slice(0, 24);
const html = (text) => JSON.stringify({ type: "tiptap", data: `<p>${text}</p>` });

try {
  const signup = await fetch(`${API}/users`, {
    method: "POST",
    body: new URLSearchParams({
      email: `notas-check-${Date.now()}@example.com`,
      password: "notas-check-password",
      client_id: "notesnook"
    })
  });
  const { access_token: token } = await signup.json();
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  };
  const publish = (body) =>
    fetch(`${API}/monographs/v2`, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });

  // ---- 1 ----
  const noteId = id();
  const published = await publish({
    id: noteId,
    title: "El buen pastor",
    selfDestruct: false,
    content: html("Juan 10:11")
  });
  assert.equal(published.status, 200, await published.clone().text());
  const { publishUrl } = await published.json();
  const slug = publishUrl.split("/s/")[1];
  const read = await (await fetch(`${API}/monographs/v2/${slug}`)).json();
  assert.equal(read.title, "El buen pastor");
  console.log(`1. se publica y se lee por su enlace (${publishUrl})`);

  // ---- 2 ----
  await fetch(`${API}/monographs/v2/${slug}/view`);
  const analytics = await fetch(`${API}/monographs/${noteId}/analytics`, {
    headers
  });
  assert.equal(analytics.status, 200, await analytics.clone().text());
  assert.equal((await analytics.json()).totalViews, 1);
  console.log("2. el contador de vistas sale sin plan Pro y cuenta la vista");

  // ---- 3 ----
  const once = await publish({
    id: id(),
    title: "Una sola vez",
    selfDestruct: true,
    content: html("se borra al leerla")
  });
  const onceSlug = (await once.json()).publishUrl.split("/s/")[1];
  await fetch(`${API}/monographs/v2/${onceSlug}/view`);
  const gone = await fetch(`${API}/monographs/v2/${onceSlug}`);
  const goneBody = gone.ok ? await gone.json() : null;
  assert.ok(!goneBody?.title, "la nota sigue ahí después de leerla");
  console.log("3. la que se borra al leerla ya no está después de la primera vista");

  // ---- 4 ----
  const big = await publish({
    id: id(),
    title: "Demasiado grande",
    selfDestruct: false,
    content: JSON.stringify({
      type: "tiptap",
      // ~11 MB of an image, as it travels (base64).
      data: `<img src="data:image/png;base64,${Buffer.concat(
        Array.from({ length: 130 }, () =>
          crypto.getRandomValues(new Uint8Array(65536))
        )
      ).toString("base64")}">`
    })
  });
  assert.equal(big.status, 400);
  assert.match(await big.text(), /too big.*10mb/i);
  console.log("4. una nota de más de 10 MB se rechaza con un error claro");

  console.log("GREEN: las notas compartidas se publican, cuentan vistas, se borran al leerse y respetan los 10 MB.");
} finally {
  s3.close();
}
