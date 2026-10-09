import assert from "node:assert/strict";
import test from "node:test";
import { ConfigurationBackendUnavailableError } from "../../apps/controller/src/drivers/configuration/kubernetes/index.ts";
import { dependencyUnavailableLogFields } from "../../apps/controller/src/http/errors.ts";
import { createOccLogger, WITHHELD_ERROR_TEXT } from "../../apps/controller/src/logging.ts";
import { DependencyUnavailableError } from "../../packages/occ/src/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";

const GENERIC = "A required platform dependency is unavailable.";
const SECRET_VALUE = "sk-proj-dependencylogvalue0123456789";
// What a Kubernetes client error can carry: the request and the answer's body.
const CLIENT_TEXT =
  "POST /api/v1/namespaces/t/configmaps Authorization: Bearer clienttoken0123456789";

function capturedLogger() {
  const lines = [];
  const logger = createOccLogger({
    component: "occ-api",
    level: "info",
    destination: {
      write(chunk) {
        lines.push(
          ...String(chunk)
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
        );
        return true;
      },
    },
  });
  return { lines, logger };
}

// OCC passes a Configuration Driver's DependencyUnavailableError through to HTTP unchanged, as it
// does a ServiceAccount Driver's.
async function configurationFixture(t, createError) {
  const { lines, logger } = capturedLogger();
  const configurationDriver = createTestConfigurationDriver({ id: "console-configuration" });
  const fixture = await createConsoleAppFixture(t, {
    logger,
    configurationDriver,
    secretDriver: createTestSecretDriver({ id: "console-secret" }),
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Dependency log", { ready: true });
  const create = configurationDriver.create;
  configurationDriver.create = async (configuration) => {
    if (createError !== undefined) {
      throw createError;
    }
    return create(configuration);
  };
  return { fixture, lines, namespace };
}

function createConfiguration(fixture, namespace) {
  return fixture.request("POST", `/namespaces/${namespace.id}/configurations`, {
    body: { kind: "agent", values: { note: SECRET_VALUE } },
  });
}

function dependencyWarnings(lines) {
  return lines.filter((line) => line.event === "http.dependency_unavailable");
}

test("a 503 DEPENDENCY_UNAVAILABLE keeps its generic body and logs its cause by request ID", async (t) => {
  const error = new ConfigurationBackendUnavailableError(
    "The Kubernetes ConfigMap create outcome is unknown after timeout.",
  );
  error.cause = Object.assign(new Error(CLIENT_TEXT), {
    name: "ApiException",
    code: 500,
    body: CLIENT_TEXT,
    cause: Object.assign(new Error(`socket ${CLIENT_TEXT}`), { code: "ECONNRESET" }),
  });
  const { fixture, lines, namespace } = await configurationFixture(t, error);
  const response = await createConfiguration(fixture, namespace);

  assert.equal(response.status, 503, JSON.stringify(response.body));
  assert.deepEqual(response.body.error, { code: "DEPENDENCY_UNAVAILABLE", message: GENERIC });
  const warnings = dependencyWarnings(lines);
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  const { time: _time, ...warning } = warnings[0];
  assert.deepEqual(warning, {
    severity: "WARN",
    service: "occ-api",
    event: "http.dependency_unavailable",
    requestId: response.body.meta.requestId,
    method: "POST",
    route: "/namespaces/:namespaceId/configurations",
    errorClass: "ConfigurationBackendUnavailableError",
    message: "The Kubernetes ConfigMap create outcome is unknown after timeout.",
    causes: [{ errorClass: "ApiException", code: 500 }, { code: "ECONNRESET" }],
  });
  // Neither the submitted value nor the client error's text reaches any log line.
  const logged = JSON.stringify(lines);
  assert.equal(logged.includes(SECRET_VALUE), false);
  assert.equal(logged.includes("clienttoken"), false);
});

test("a dependency message that resembles a credential is withheld from the log", async (t) => {
  const { fixture, lines, namespace } = await configurationFixture(
    t,
    new DependencyUnavailableError(`Upstream answered with ${SECRET_VALUE}.`),
  );
  const response = await createConfiguration(fixture, namespace);

  assert.equal(response.status, 503, JSON.stringify(response.body));
  assert.equal(response.body.error.message, GENERIC);
  const warnings = dependencyWarnings(lines);
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.equal(warnings[0].message, WITHHELD_ERROR_TEXT);
  assert.equal(JSON.stringify(lines).includes(SECRET_VALUE), false);
});

test("responses other than a dependency 503 log no dependency warning", async (t) => {
  const { fixture, lines, namespace } = await configurationFixture(t, undefined);
  const created = await createConfiguration(fixture, namespace);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const missing = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/cfg_00000000-0000-4000-8000-000000000000`,
  );
  assert.equal(missing.status, 404, JSON.stringify(missing.body));
  const invalid = await fixture.request("POST", `/namespaces/${namespace.id}/configurations`, {
    body: { kind: "agent" },
  });
  assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
  assert.deepEqual(dependencyWarnings(lines), []);
});

test("dependency log fields keep only the class and code of a bounded cause chain", () => {
  const first = Object.assign(new Error(CLIENT_TEXT), { code: "not a code: Bearer x" });
  const second = Object.assign(new Error(CLIENT_TEXT), { name: "Bearer abc", code: 1.5 });
  first.cause = second;
  second.cause = first;
  const error = new DependencyUnavailableError("The selected secret Driver is unavailable.");
  error.cause = first;
  assert.deepEqual(dependencyUnavailableLogFields(error), {
    errorClass: "DependencyUnavailableError",
    message: "The selected secret Driver is unavailable.",
    causes: [{}, {}],
  });

  let chain = new Error("root");
  for (let depth = 0; depth < 6; depth += 1) {
    chain = Object.assign(new Error(`level ${depth}`), { code: `L${depth}`, cause: chain });
  }
  const deep = new DependencyUnavailableError("Deep outage.\nNext line\u0000.");
  deep.cause = chain;
  const fields = dependencyUnavailableLogFields(deep);
  assert.equal(fields.message, "Deep outage. Next line .");
  assert.deepEqual(
    fields.causes.map(({ code }) => code),
    ["L5", "L4", "L3", "L2"],
  );
  const url = new DependencyUnavailableError("Fetch https://user:pass@example.test/x failed.");
  assert.equal(dependencyUnavailableLogFields(url).message, WITHHELD_ERROR_TEXT);
});
