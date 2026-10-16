import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { OpenShellGateway } from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";

test(
  "Agent policy HTTP admission persists bounded grants without changing an admitted revision",
  requiresPostgres,
  async (t) => {
    const grant = {
      id: "python-demo",
      binary: "/usr/bin/python3.11",
      host: "example.org",
      ports: [{ from: 443, to: 443 }],
    };
    // The real Driver validates and freezes policy; this case proves HTTP/IAM/PostgreSQL admission,
    // while the OpenShell runtime lane proves enforcement and loaded-version application.
    const sandboxDriver = new OpenShellSandboxDriver(
      {
        gateway: { workspaceMode: "operator" },
        kubernetes: {
          runtimeClassName: "openshell-sandbox",
          serviceAccount: { mode: "gatewayConfigured" },
          sandboxDataMount: {
            subPath: "workspace",
            mountPath: "/sandbox/enterprise",
            readOnly: false,
          },
        },
        policy: {
          process: { runAsUser: "1000", runAsGroup: "1000" },
          networkPolicies: [
            {
              name: "python-default",
              binaries: [{ path: grant.binary }],
              endpoints: [{ host: "example.com", ports: [443], tls: "skip" }],
            },
          ],
        },
      },
      {
        id: "policy-openshell",
        implementation: "openshell",
        backend: {
          id: "openshell",
          drivers: { sandbox: "policy-openshell", credential_gateway: "policy-credentials" },
          client: new OpenShellGateway({ serviceName: "openshell-gateway" }),
        },
      },
    );
    const { pool, state, inject, deployAgent } = await createPostgresAgentApp(t, {
      label: "sandbox-policy",
      authSecret: "sandbox-policy-postgres-session-secret-32-characters",
      sandboxDriver,
      controllerOptions: { sandboxNetworkPolicyCeiling: [grant] },
    });
    const { namespace, agent, revision } = await deployAgent("Sandbox policy");
    const base = `/namespaces/${namespace.id}/agents/${agent.id}/sandbox-policy`;
    const read = await inject("GET", base);
    assert.equal(read.statusCode, 200, read.body);
    const original = read.json().data.policy;
    assert.equal(read.json().data.editingEnabled, false);
    assert.deepEqual(original.additions, []);
    assert.deepEqual(revision.sandboxPolicy.additions, []);
    assert.deepEqual(read.json().data.defaults, revision.sandboxPolicy.defaults);

    // The general Agent endpoint cannot bypass the separately administered editing flag.
    const bypass = await inject("PATCH", `/namespaces/${namespace.id}/agents/${agent.id}`, {
      sandboxPolicyEditing: true,
    });
    assert.equal(bypass.statusCode, 400, bypass.body);

    const disabled = await inject("PUT", base, { expectedVersion: 1, additions: [grant] });
    assert.equal(disabled.statusCode, 409, disabled.body);
    const enabled = await inject("PATCH", `${base}/editing`, { enabled: true });
    assert.equal(enabled.statusCode, 200, enabled.body);
    const broad = await inject("PUT", base, {
      expectedVersion: 1,
      additions: [{ ...grant, host: "*.example.org" }],
    });
    assert.equal(broad.statusCode, 409, broad.body);
    const wrongBinary = await inject("PUT", base, {
      expectedVersion: 1,
      additions: [{ ...grant, binary: "/usr/bin/python3" }],
    });
    assert.equal(wrongBinary.statusCode, 409, wrongBinary.body);
    const wrongPort = await inject("PUT", base, {
      expectedVersion: 1,
      additions: [{ ...grant, ports: [{ from: 443, to: 444 }] }],
    });
    assert.equal(wrongPort.statusCode, 409, wrongPort.body);

    const changed = await inject("PUT", base, { expectedVersion: 1, additions: [grant] });
    assert.equal(changed.statusCode, 200, changed.body);
    assert.equal(changed.json().data.version, 2);
    assert.deepEqual(changed.json().data.additions, [grant]);
    const stale = await inject("PUT", base, { expectedVersion: 1, additions: [] });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.deepEqual(
      (await state.read((view) => view.revisions.findRevision(namespace.id, agent.id, revision.id)))
        .sandboxPolicy.additions,
      [],
      "saving a policy must preserve immutable deployment evidence",
    );

    // Disabling edits preserves approved grants; explicit redeployment consumes the desired policy.
    const off = await inject("PATCH", `${base}/editing`, { enabled: false });
    assert.equal(off.statusCode, 200, off.body);
    assert.deepEqual((await inject("GET", base)).json().data.policy.additions, [grant]);
    assert.equal(
      (await inject("PUT", base, { expectedVersion: 2, additions: [] })).statusCode,
      409,
    );
    const deployed = await inject("POST", `/namespaces/${namespace.id}/agents/${agent.id}/deploy`);
    assert.equal(deployed.statusCode, 202, deployed.body);
    const saved = await state.read((view) =>
      view.revisions.findRevision(namespace.id, agent.id, deployed.json().data.id),
    );
    assert.deepEqual(saved.sandboxPolicy.additions, [grant]);
    assert.equal(saved.sandboxPolicy.version, 2);
    assert.deepEqual(saved.sandboxPolicy.defaults, revision.sandboxPolicy.defaults);

    // Database ownership and document constraints protect persistence even outside HTTP admission.
    await assert.rejects(
      pool.query(
        "UPDATE occ.sandbox_policies SET document = jsonb_set(document,'{agentId}',to_jsonb($2::text)) WHERE id = $1",
        [original.id, `agt_${randomUUID()}`],
      ),
      { code: "23514" },
    );
    await assert.rejects(
      pool.query(
        "UPDATE occ.sandbox_policies SET document = jsonb_set(document,'{additions}', $2::jsonb) WHERE id = $1",
        [original.id, JSON.stringify([{ ...grant, ports: [{ from: 444, to: 443 }] }])],
      ),
      { code: "23514" },
    );
    await inject("PATCH", `${base}/editing`, { enabled: true });
    // Agent update authority cannot substitute for the independent policy-resource check.
    const restriction = `restriction-${randomUUID()}`;
    await pool.query(
      "INSERT INTO occ.iam_restrictions (id,namespace_id,action,resource_kind,resource_id,effect) VALUES ($1,$2,'update','sandbox_policy',$3,'deny')",
      [restriction, namespace.id, original.id],
    );
    const refused = await inject("PUT", base, { expectedVersion: 2, additions: [grant] });
    assert.equal(refused.statusCode, 403, refused.body);
    const denial = await pool.query(
      "SELECT actor_id FROM occ.audit_events WHERE kind = 'authorization_denial' AND details#>>'{__occAuditMetadata,authorization,resource,id}' = $1",
      [original.id],
    );
    assert.ok(denial.rowCount > 0, "the exact-resource authorization denial must be attributable");

    const other = await deployAgent("Independent policy authority");
    const otherBase = `/namespaces/${other.namespace.id}/agents/${other.agent.id}/sandbox-policy`;
    const crossNamespace = await inject(
      "GET",
      `/namespaces/${namespace.id}/agents/${other.agent.id}/sandbox-policy`,
    );
    assert.equal(crossNamespace.statusCode, 404, crossNamespace.body);
    assert.equal(
      (await inject("PATCH", `${otherBase}/editing`, { enabled: true })).statusCode,
      200,
    );
    // Policy-resource update permission alone cannot replace exact-Agent manage_policy.
    await pool.query(
      "INSERT INTO occ.iam_restrictions (id,namespace_id,action,resource_kind,resource_id,effect) VALUES ($1,$2,'manage_policy','agent',$3,'deny')",
      [`restriction-${randomUUID()}`, other.namespace.id, other.agent.id],
    );
    const agentRefused = await inject("PUT", otherBase, { expectedVersion: 1, additions: [grant] });
    assert.equal(agentRefused.statusCode, 403, agentRefused.body);
    assert.deepEqual((await inject("GET", otherBase)).json().data.policy.additions, []);
  },
);
