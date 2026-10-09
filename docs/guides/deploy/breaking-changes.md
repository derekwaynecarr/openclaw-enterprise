# Breaking-change notices

OpenClaw Enterprise (OCE) is pre-alpha and has no stable release, so a newer
main can refuse or break an Installation that an older build created. Each
change like that gets an entry here: what breaks, who is affected, how to tell,
and the steps. Before an upgrade, read every entry dated after the source commit
you run now, then follow the [upgrade checklist](upgrade-checklist.md) and
[production image upgrades](production-upgrade.md).

Entries are newest first. Steps marked _untested_ have not been run against a
real Installation.

## 2026-10-07: migration 0049 refuses managed ChatGPT service-account Agents

**What breaks.** Since #1648 (`94957cedc`), migration
`0049_codex_pat_sources` stops the upgrade with SQLSTATE `23514`
(`Unsupported legacy managed PAT authentication`) when any Agent, Agent
revision or queued provisioning request still uses the retired
`chatgpt_service_account` Harness auth. The method is now `codex_pat` with a
service-account source. The old release keeps running; nothing is changed.

**Who is affected.** Installations that ever deployed an Agent with
`harnessAuth.method` `chatgpt_service_account`, including Agents since changed
to another method, because their old revisions keep it.

**How to tell.** Before upgrading, on the old release:

```bash
occ agent list -o json | jq -r '.[] | select(.harnessAuth.method == "chatgpt_service_account") | .id'
```

Run it in every Namespace (`--namespace`). An Agent changed away from the method
still has old revisions; check them with
`GET /namespaces/<id>/agents/<agent>/revisions`.

**Steps.** Deleting an Agent removes its revisions and provisioning requests,
which clears the refusal.

1. Record each affected Agent's settings (`occ agent get <id> -o json`) and
   workspace files.
2. Delete it on the old release (`occ agent delete <id>`) and wait until
   `occ agent list` no longer shows it.
3. Upgrade.
4. Re-create the Agent with
   `"harnessAuth": {"method": "codex_pat", "source": {"kind": "service_account", "namespaceId": "<ns>", "id": "<sa>"}}`,
   then deploy it.

_Untested_ on a real Installation. The split-layout script below does steps 1, 2
and 4 for every Agent it moves.

## 2026-10-05: split-layout tenants block the controller upgrade

**What breaks.** Since #925 (`dd344a97c`), a single-cluster Installation keeps
each Namespace's Gateways and Harnesses in one tenant namespace. Releases before
it kept Gateways in a separate `oce-gateways-<hash>` namespace. The current API
and worker refuse to start while such a namespace exists, and the
[image upgrade helper](production-upgrade.md) stops at its startup preflight
(`Existing split-layout Gateway storage prevents this single-cluster upgrade`)
before it changes anything. See
[split-layout installations](../../reference/drivers/kubernetes-compute.md#existing-split-layout-installations).

**Who is affected.** Single-cluster Installations created by the 2026-09-28
release, or by any main before `dd344a97c`, that have at least one Namespace.
The experimental two-cluster profile is not affected.

**How to tell.**

```bash
kubectl get namespaces -l openclaw.dev/gateway-namespace -L openclaw.dev/namespace
```

A row with an empty `NAMESPACE` column is a split-layout tenant.

**What you lose.** No migration moves the old namespaces, so their tenants are
exported, deleted and re-created. These come back, under new IDs: Namespaces,
Secrets (you supply the values again), Configurations, Presets, credential
sources, Roles, access bindings, service accounts (without issued credentials)
and Agents with their `AGENTS.md`, `SOUL.md`, `IDENTITY.md` and `USER.md`.
Agents that were running are deployed again. These do not come back:

- chat history and other Gateway state;
- Harness workspace files beyond those four, generated images and Codex
  threads;
- Agent revision history and bindings to old revisions;
- issued service-account credentials and Agent runtime credentials;
- the old IDs, so update anything outside OCE that names them.

Accounts, Installation service keys and the audit history stay in the database.

**Steps.** Run these from a checkout of the target release, with `occ` set up
for the old release as an administrator (`OCC_URL`,
`OCC_SERVICE_KEY_FILE`, `OCC_CA_BUNDLE`). The script talks to OCC only. Keep its
files private: the bundle holds Configurations and workspace files, and the
values file holds Secrets.

1. Export every Namespace from the old release:

   ```bash
   node scripts/split-layout-tenants.mjs export --out /secure/occ/tenants.json
   ```

2. Write the Secret values to a `0600` file such as
   `/secure/occ/tenant-secrets.json`, keyed by Namespace name, then Secret name:
   `{"team-a": {"model-key": "..."}}`. List the names with
   `jq '.namespaces[] | {name, secrets: [.secrets[].name]}' /secure/occ/tenants.json`.
3. Delete them on the old release. The command refuses if a Namespace gained an
   Agent or Secret after the export:

   ```bash
   node scripts/split-layout-tenants.mjs discard --bundle /secure/occ/tenants.json --yes
   kubectl get namespaces -l openclaw.dev/gateway-namespace
   ```

   Continue when no `oce-gateways-*` namespace is left.

4. [Upgrade the control plane](production-upgrade.md#upgrade-the-control-plane)
   as usual. The preflight now passes.
5. Re-create the tenants:

   ```bash
   node scripts/split-layout-tenants.mjs import --bundle /secure/occ/tenants.json \
     --secret-values /secure/occ/tenant-secrets.json --map /secure/occ/tenant-ids.json
   ```

   It creates the Namespaces and exits `3` until they are `ready`.
   [Grant tenant RoleBindings](production-agents.md#grant-tenant-rolebindings)
   for each one, then run the same command again. The ID map records every old
   and new ID, so a rerun after any failure resumes. Exit `4` lists Agents whose
   deploy failed, such as a service-account Agent without an issued credential.

6. Check the Agents (`occ agent list`) and re-issue any service-account
   credentials.

## 2026-10-01: released dedicated Agents fail to redeploy

**What breaks.** Since `7e831ba37`, the dedicated Harness init container makes
its `workspace` and `generated-images` directories private (`0700`). Agents
deployed by the 2026-09-28 release have those directories owned by root, so on
the first redeploy the init container fails with `EPERM` and the Harness stays
in `Init:Error`. The upgrade helper's runtime step redeploys every running Agent.

**Who is affected.** Installations whose dedicated Agents were deployed by the
2026-09-28 release and are redeployed by a controller from `7e831ba37` up to,
but not including, #1652 (`42c43fcd0`, 2026-10-09).

**How to tell.** The Harness Pod's `prepare-private-state` container exits with
`EPERM: operation not permitted, chmod '/harness-workspace-state/workspace'`.

**Steps.** Upgrade the controller to `42c43fcd0` or later, then deploy the
Agent again (`occ agent deploy <id>`). The init container moves each old
directory aside, recreates it as uid 1000 with mode `0700` and moves the files
back. Entries it cannot move back are left in `.workspace.kubelet-created` or
`.generated-images.kubelet-created` beside it and named in the init log.
