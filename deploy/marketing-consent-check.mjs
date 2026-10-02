// SPDX-License-Identifier: AGPL-3.0-or-later
// Epigrapho: checks the news email consent against a local stack, with a
// stand-in for El Dugout. Needs MongoDB (replica set rs0) on localhost:27017
// and Streetwriters.Identity, Notesnook.API and Streetwriters.Messenger
// (deleting an account waits on it) running with SELF_HOSTED=1,
// S3_SERVICE_URL=http://localhost:9000,
// EPIGRAPHO_DUGOUT_URL=http://localhost:8899/hook and
// EPIGRAPHO_DUGOUT_SECRET=local-check-secret. This script serves both the
// El Dugout stand-in (8899) and an empty S3 (9000).
//
// Checks that:
//   1. a new account starts at no;
//   2. saying no before ever saying yes tells El Dugout nothing;
//   3. yes and no reach El Dugout signed, with the locale and signup date;
//   4. while El Dugout is down the server retries, and the event arrives
//      once it is back;
//   5. deleting the account tells El Dugout.
//
//   node deploy/marketing-consent-check.mjs
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";

const SECRET = "local-check-secret";
const API = "http://localhost:5264";
const AUTH = "http://localhost:8264";
const events = [];
let down = false;
let refused = 0;

const dugout = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const signature = createHmac("sha256", SECRET).update(body).digest("hex");
    assert.equal(req.headers["x-epigrapho-signature"], signature, "bad signature");
    if (down) {
      refused++;
      res.statusCode = 500;
      return res.end();
    }
    events.push(JSON.parse(body));
    res.end();
  });
}).listen(8899);
const s3 = createServer((req, res) => {
  res.setHeader("Content-Type", "application/xml");
  res.end(
    '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>attachments</Name><KeyCount>0</KeyCount><IsTruncated>false</IsTruncated></ListBucketResult>'
  );
}).listen(9000);

const form = (data) => new URLSearchParams(data);
const email = `consent-check-${Date.now()}@example.com`;
const password = "consent-check-password";

async function waitFor(count, timeout = 10000) {
  const start = Date.now();
  while (events.length < count) {
    if (Date.now() - start > timeout) throw new Error(`waited for ${count} events, got ${events.length}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

try {
  const signup = await fetch(`${API}/users`, {
    method: "POST",
    body: form({ email, password, client_id: "notesnook" })
  });
  assert.equal(signup.status, 200, await signup.clone().text());
  const { access_token: token } = await signup.json();
  const headers = { Authorization: `Bearer ${token}` };
  const consent = async () =>
    (await (await fetch(`${API}/users`, { headers })).json()).marketingConsent;
  const change = async (enabled) => {
    const response = await fetch(`${AUTH}/account`, {
      method: "PATCH",
      headers,
      body: form({ type: "change_marketing_consent", enabled, locale: "es-MX" })
    });
    assert.equal(response.status, 200);
  };

  // ---- 1 and 2 ----
  assert.equal(await consent(), false);
  await change(false);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.equal(events.length, 0);
  console.log("1. una cuenta nueva empieza en no; 2. un no sin sí previo no avisa");

  // ---- 3 ----
  await change(true);
  assert.equal(await consent(), true);
  await change(false);
  assert.equal(await consent(), false);
  await waitFor(2);
  const today = new Date().toISOString().slice(0, 10);
  assert.deepEqual(
    events.map(({ event, email: to, consent, locale, signupDate }) => [event, to, consent, locale, signupDate]),
    [
      ["consent", email, true, "es-MX", today],
      ["consent", email, false, "es-MX", today]
    ]
  );
  console.log("3. el sí y el no llegan firmados, con idioma y fecha de alta");

  // ---- 4 ----
  down = true;
  await change(true);
  while (refused < 1) await new Promise((resolve) => setTimeout(resolve, 200));
  down = false;
  await waitFor(3, 90000);
  assert.equal(events[2].consent, true);
  console.log(`4. con El Dugout caído reintenta (${refused} rechazo) y el aviso llega después`);

  // ---- 5 ----
  const deleted = await fetch(`${API}/users/delete`, {
    method: "POST",
    headers,
    body: form({ password })
  });
  assert.equal(deleted.status, 200, await deleted.clone().text());
  await waitFor(4);
  assert.equal(events[3].event, "deleted");
  console.log("5. borrar la cuenta avisa a El Dugout");

  console.log("GREEN: el consentimiento es de alta y El Dugout se entera de cada cambio.");
} finally {
  dugout.close();
  s3.close();
}
