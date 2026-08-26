// Source and fixture evidence: prove immutable production provenance and isolated fixture mounts.
// Inputs are SQLite/corpus paths and fixture artifacts; outputs are hashed evidence; failures are fail-closed.
// Ordering snapshots source bytes, then validates logical identity and corpus scope.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as p from './certified-primitives.mjs';
import { SOAK_RUNTIME_CONFIGURATION } from '../../loadtest_elixir/soak-invariants.mjs';

const { stableJson, invariant, commandOutput, digestRegularFile, directoryTreeRecords,
  CERTIFIED_CPUS, CERTIFIED_CPUSET, CERTIFIED_MEMORY_BYTES, CERTIFIED_PIDS,
  CERTIFIED_NOFILE, REQUIRED_ERL_AFLAGS, PRODUCTION_SOURCE_DATABASE,
  PRODUCTION_SOURCE_CORPUS, REQUIRED_FIXTURE_GROUP_SIZE } = p;

export function sqliteJson(database, sql) {
  const uri = `${pathToFileURL(path.resolve(database)).href}?immutable=1`;
  const output = commandOutput('sqlite3', ['-readonly', '-json', uri, sql], { maxBuffer: 64 * 1024 * 1024 });
  return output ? JSON.parse(output) : [];
}

export function validateProductionSourceSummary(summary) {
  const database = summary?.database;
  const counts = database?.counts;
  const corpus = summary?.corpus;
  invariant(summary?.schemaVersion === 1 && summary?.type === 'cascade-production-source-snapshot',
    'production source snapshot schema is invalid');
  invariant(database?.sha256 === PRODUCTION_SOURCE_DATABASE.sha256
    && database?.bytes === PRODUCTION_SOURCE_DATABASE.bytes,
  'production source database differs from the approved immutable snapshot');
  invariant(stableJson(counts) === stableJson(PRODUCTION_SOURCE_DATABASE.counts),
    'production source database baseline differs from the approved snapshot');
  invariant(database.quickCheck === 'ok' && database.foreignKeyViolations === 0,
    'production source database failed SQLite integrity checks');
  invariant(corpus?.sha256 === PRODUCTION_SOURCE_CORPUS.sha256
    && corpus?.bytes === PRODUCTION_SOURCE_CORPUS.bytes
    && corpus?.files === PRODUCTION_SOURCE_CORPUS.files,
  'production source corpus differs from the approved immutable snapshot');
  for (const name of ['vaults', 'qmd']) {
    invariant(stableJson(corpus?.[name]) === stableJson(PRODUCTION_SOURCE_CORPUS[name]),
      `production source ${name} corpus differs from the approved immutable snapshot`);
  }
  invariant(corpus.bytes === corpus.vaults.bytes + corpus.qmd.bytes
    && corpus.files === corpus.vaults.files + corpus.qmd.files
    && corpus.sha256 === createHash('sha256').update(stableJson({
      qmd: corpus.qmd,
      vaults: corpus.vaults,
    })).digest('hex'),
  'production source corpus aggregate differs from its vault/QMD evidence');
  return summary;
}

export function collectProductionSourceEvidence(databaseFilename, corpusRoot) {
  const database = digestRegularFile(databaseFilename, 'production source database');
  for (const suffix of ['-wal', '-shm']) {
    invariant(!fs.existsSync(`${database.path}${suffix}`),
      `production source database has a live ${suffix.slice(1).toUpperCase()} sidecar`);
  }
  const databaseUri = `${pathToFileURL(database.path).href}?immutable=1`;
  const sql = `
SELECT
  (SELECT count(*) FROM users) AS users,
  (SELECT count(*) FROM vaults) AS vaults,
  (SELECT count(*) FROM vault_members) AS memberships,
  (SELECT count(*) FROM notes) AS notes,
  (SELECT count(*) FROM chat_messages) AS messages,
  (SELECT count(*) FROM runs) AS runs,
  (SELECT count(*) FROM run_events) AS runEvents,
  (SELECT count(*) FROM delegated_runs) AS delegatedRuns,
  (SELECT count(*) FROM delegated_runs d JOIN runs r ON r.id=d.run_id
    WHERE r.status IN ('queued','running')) AS openDelegatedRuns,
  (SELECT max(id) FROM runs) AS maxRunId,
  (SELECT count(*) FROM pragma_foreign_key_check) AS foreignKeyViolations,
  (SELECT group_concat(quick_check, ',') FROM pragma_quick_check) AS quickCheck;
`;
  const rows = JSON.parse(commandOutput('sqlite3', ['-readonly', '-json', databaseUri, sql]));
  invariant(rows.length === 1, `production source database query returned ${rows.length} rows`);
  const databaseAfterQuery = digestRegularFile(database.path, 'production source database');
  invariant(database.sha256 === databaseAfterQuery.sha256 && database.bytes === databaseAfterQuery.bytes,
    'production source database changed while provenance was collected');
  for (const suffix of ['-wal', '-shm']) {
    invariant(!fs.existsSync(`${database.path}${suffix}`),
      `production source database query created a ${suffix.slice(1).toUpperCase()} sidecar`);
  }
  const { foreignKeyViolations, quickCheck, ...counts } = rows[0];
  const vaultCorpusRoot = path.join(path.resolve(corpusRoot), 'vaults');
  const expectedVaultRoots = ['1', '3', '4', '5', '6', '7', 'My Vault'].sort();
  const actualVaultRoots = fs.readdirSync(vaultCorpusRoot, { withFileTypes: true })
    .map((entry) => entry.name).sort();
  invariant(stableJson(actualVaultRoots) === stableJson(expectedVaultRoots),
    'production source corpus must contain only the seven approved production vault roots');
  const vaults = directoryTreeEvidence(vaultCorpusRoot, 'production vault corpus');
  const qmd = directoryTreeEvidence(path.join(path.resolve(corpusRoot), 'qmd'), 'production QMD corpus');
  return validateProductionSourceSummary({
    schemaVersion: 1,
    type: 'cascade-production-source-snapshot',
    database: { sha256: database.sha256, bytes: database.bytes, counts, quickCheck, foreignKeyViolations },
    corpus: {
      sha256: createHash('sha256').update(stableJson({ qmd, vaults })).digest('hex'),
      bytes: vaults.bytes + qmd.bytes,
      files: vaults.files + qmd.files,
      vaults,
      qmd,
    },
  });
}
export function capacityFixtureIdentities(artifact) {
  return artifact.text.split(/\r?\n/u).filter(Boolean).map((line, index) => {
    const fixture = JSON.parse(line);
    const claims = JSON.parse(Buffer.from(fixture.token.split('.')[1], 'base64url').toString('utf8'));
    return {
      sourceIndex: index,
      userId: claims.id,
      username: claims.username,
      vaultId: fixture.vaultId,
      channelId: fixture.channelId,
      ownedChatChannels: fixture.ownedChatChannels,
    };
  });
}

export function validateFixtureDatabaseIdentity(database, fixtureArtifact) {
  const fixtures = capacityFixtureIdentities(fixtureArtifact);
  const users = new Map(sqliteJson(database,
    'SELECT id,username,password_hash,auth_version FROM users;')
    .map((row) => [row.id, row]));
  const memberships = new Map(sqliteJson(database, 'SELECT vault_id,user_id,role FROM vault_members;')
    .map((row) => [`${row.vault_id}\u0000${row.user_id}`, row]));
  const vaults = new Map(sqliteJson(database, 'SELECT id,created_by FROM vaults;')
    .map((row) => [row.id, row]));
  const channels = new Map(sqliteJson(database,
    "SELECT id,vault_id,created_by,content FROM notes WHERE content='cascade://chat-channel';")
    .map((row) => [row.id, row]));
  const activities = new Map(sqliteJson(database,
    'SELECT note_id,actor_user_id,count(*) AS activityCount FROM community_note_activity GROUP BY note_id,actor_user_id;')
    .map((row) => [`${row.note_id}\u0000${row.actor_user_id}`, row.activityCount]));
  const ownerByGroup = new Map();
  for (const fixture of fixtures) {
    if (fixture.ownedChatChannels === 1) ownerByGroup.set(fixture.vaultId, fixture.userId);
  }
  let userMismatches = 0;
  let membershipMismatches = 0;
  let vaultMismatches = 0;
  let channelMismatches = 0;
  let activityMismatches = 0;
  for (const fixture of fixtures) {
    const user = users.get(fixture.userId);
    if (user?.username !== fixture.username
      || user?.password_hash !== '!capacity-fixture-no-password-login!'
      || user?.auth_version !== 0) userMismatches += 1;
    const membership = memberships.get(`${fixture.vaultId}\u0000${fixture.userId}`);
    const expectedRole = fixture.ownedChatChannels === 1 ? 'owner' : 'editor';
    if (membership?.role !== expectedRole) membershipMismatches += 1;
  }
  for (const [vaultId, ownerId] of ownerByGroup) {
    const vault = vaults.get(vaultId);
    if (vault?.created_by !== ownerId) vaultMismatches += 1;
    const fixture = fixtures.find((entry) => entry.vaultId === vaultId);
    const channel = channels.get(fixture?.channelId);
    if (channel?.vault_id !== vaultId || channel?.created_by !== ownerId
        || channel?.content !== 'cascade://chat-channel') channelMismatches += 1;
    if (activities.get(`${fixture?.channelId}\u0000${ownerId}`) !== 1) activityMismatches += 1;
  }
  const evidence = {
    users: fixtures.length,
    groups: ownerByGroup.size,
    userMismatches,
    membershipMismatches,
    vaultMismatches,
    channelMismatches,
    activityMismatches,
    identitySha256: createHash('sha256').update(stableJson(fixtures)).digest('hex'),
  };
  invariant(evidence.users === fixtures.length
    && evidence.groups === fixtures.length / REQUIRED_FIXTURE_GROUP_SIZE
    && userMismatches === 0 && membershipMismatches === 0
    && vaultMismatches === 0 && channelMismatches === 0 && activityMismatches === 0,
  'capacity fixture identities do not exactly match users, memberships, vault owners, and channels');
  return evidence;
}

export function inspectContainerDataMount(containerReference) {
  const [inspection] = JSON.parse(commandOutput('docker', ['inspect', containerReference]));
  invariant(inspection?.Id, `capacity container ${containerReference} is unavailable`);
  const environment = Object.fromEntries((inspection.Config?.Env || []).map((entry) => {
    const separator = entry.indexOf('=');
    return separator < 0 ? [entry, ''] : [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
  const containerDatabase = environment.DOCS_DB_PATH;
  invariant(typeof containerDatabase === 'string' && path.posix.isAbsolute(containerDatabase),
    'capacity container has no absolute DOCS_DB_PATH');
  const mounts = (inspection.Mounts || []).filter((mount) => (
    mount.Type === 'bind'
    && (containerDatabase === mount.Destination
      || containerDatabase.startsWith(`${mount.Destination.replace(/\/$/u, '')}/`))
  ));
  invariant(mounts.length === 1 && mounts[0].RW === true,
    'capacity container database is not on one writable bind mount');
  const mount = mounts[0];
  const relativeDatabase = path.posix.relative(mount.Destination, containerDatabase);
  invariant(relativeDatabase && !relativeDatabase.startsWith('../') && !path.posix.isAbsolute(relativeDatabase),
    'capacity container database escapes its data mount');
  const mountSource = fs.realpathSync(mount.Source);
  const hostPath = (containerPath, label) => {
    invariant(typeof containerPath === 'string'
      && (containerPath === mount.Destination
        || containerPath.startsWith(`${mount.Destination.replace(/\/$/u, '')}/`)),
    `${label} is outside the capacity data mount`);
    const relative = path.posix.relative(mount.Destination, containerPath);
    const resolved = path.resolve(mountSource, relative);
    invariant(resolved === mountSource || resolved.startsWith(`${mountSource}${path.sep}`),
      `${label} host path escapes its mount`);
    return resolved;
  };
  const database = hostPath(containerDatabase, 'capacity database');
  invariant(database.startsWith(`${mountSource}${path.sep}`), 'capacity database host path escapes its mount');
  return {
    inspection,
    database,
    mountDestination: mount.Destination,
    mountSourceSha256: createHash('sha256').update(mountSource).digest('hex'),
    relativeDatabase,
    vaultsDirectory: hostPath(environment.CASCADE_VAULTS_BASE_DIR, 'capacity vault corpus'),
    qmdDirectory: hostPath(environment.CASCADE_QMD_DIR, 'capacity QMD corpus'),
    vaultsContainerDirectory: environment.CASCADE_VAULTS_BASE_DIR,
    qmdContainerDirectory: environment.CASCADE_QMD_DIR,
  };
}

export function containerRuntimeEvidence(inspection) {
  const environment = Object.fromEntries((inspection.Config?.Env || []).map((entry) => {
    const separator = entry.indexOf('=');
    return separator < 0 ? [entry, ''] : [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
  const host = inspection.HostConfig || {};
  const nofile = (host.Ulimits || []).find((entry) => entry.Name === 'nofile');
  const envelope = {
    nanoCpus: host.NanoCpus,
    cpusetCpus: host.CpusetCpus,
    memory: host.Memory,
    memorySwap: host.MemorySwap,
    pidsLimit: host.PidsLimit,
    nofileSoft: nofile?.Soft,
    nofileHard: nofile?.Hard,
  };
  const configuration = {
    httpAcceptors: Number(environment.CASCADE_HTTP_ACCEPTORS),
    httpMaxConnections: Number(environment.CASCADE_HTTP_MAX_CONNECTIONS),
    httpBacklog: Number(environment.CASCADE_HTTP_BACKLOG),
    networkMode: /^(?:1|true)$/iu.test(environment.CASCADE_NETWORK_MODE || ''),
    trustProxyHops: Number(environment.CASCADE_TRUST_PROXY_HOPS),
    qmdWorkerEnabled: /^(?:1|true)$/iu.test(environment.CASCADE_QMD_WORKER_ENABLED || ''),
    realtimeHibernateAfterMs: Number(environment.CASCADE_REALTIME_HIBERNATE_AFTER_MS),
    runnerOrphanReclaimMs: Number(environment.CASCADE_RUNNER_ORPHAN_RECLAIM_MS),
    sqlitePoolSize: Number(environment.CASCADE_SQLITE_POOL_SIZE),
    sqliteBusyTimeoutMs: Number(environment.CASCADE_SQLITE_BUSY_TIMEOUT_MS),
  };
  invariant(envelope.nanoCpus === CERTIFIED_CPUS * 1_000_000_000
    && envelope.cpusetCpus === CERTIFIED_CPUSET
    && envelope.memory === CERTIFIED_MEMORY_BYTES
    && envelope.memorySwap === CERTIFIED_MEMORY_BYTES
    && envelope.pidsLimit === CERTIFIED_PIDS
    && envelope.nofileSoft === CERTIFIED_NOFILE && envelope.nofileHard === CERTIFIED_NOFILE,
  'capacity phase runtime envelope differs from the certified shape');
  invariant(stableJson(configuration) === stableJson(SOAK_RUNTIME_CONFIGURATION),
    'capacity phase runtime configuration differs from the certified contract');
  invariant(environment.ERL_AFLAGS === REQUIRED_ERL_AFLAGS,
    'capacity phase BEAM scheduler flags differ from the certified contract');
  return { envelope, configuration, erlAflags: environment.ERL_AFLAGS };
}

export function relativeFixtureVaultRoots(database, fixtureArtifact, containerMount) {
  const fixtureUserIds = new Set(capacityFixtureIdentities(fixtureArtifact).map((fixture) => fixture.userId));
  const rows = sqliteJson(database, 'SELECT id,root_path,created_by FROM vaults;')
    .filter((row) => fixtureUserIds.has(row.created_by));
  invariant(rows.length === fixtureUserIds.size / REQUIRED_FIXTURE_GROUP_SIZE,
    'fixture vault roots do not match the exact fixture owner cohort');
  const roots = rows.map((row) => {
    const root = String(row.root_path || '');
    let relative;
    if (path.isAbsolute(root) && (root === containerMount.vaultsDirectory
        || root.startsWith(`${containerMount.vaultsDirectory}${path.sep}`))) {
      relative = path.relative(containerMount.vaultsDirectory, root);
    } else if (root === containerMount.vaultsContainerDirectory
        || root.startsWith(`${containerMount.vaultsContainerDirectory.replace(/\/$/u, '')}/`)) {
      relative = path.posix.relative(containerMount.vaultsContainerDirectory, root);
    }
    invariant(relative && !relative.startsWith('../') && !path.isAbsolute(relative),
      `fixture vault ${row.id} root is outside the candidate vault corpus`);
    const normalized = relative.split(path.sep).join('/');
    const [topLevel] = normalized.split('/');
    invariant(topLevel && normalized.startsWith(`${topLevel}/`),
      `fixture vault ${row.id} does not have an isolated top-level root`);
    return topLevel;
  });
  const approvedRoots = new Set(['1', '3', '4', '5', '6', '7', 'My Vault']);
  invariant(new Set(roots).size === rows.length
    && roots.every((root) => !approvedRoots.has(root)),
  'fixture vault roots must be unique top-level paths disjoint from production roots');
  return roots;
}

export function compareCorpusTree(
  sourceDirectory,
  candidateDirectory,
  label,
  allowedExtraRoots,
) {
  const sourceRecords = directoryTreeRecords(sourceDirectory, `${label} approved source`);
  const candidateRecords = directoryTreeRecords(candidateDirectory, `${label} candidate`);
  const candidateByPath = new Map(candidateRecords.map((record) => [record.path, record]));
  let missingOrChanged = 0;
  for (const record of sourceRecords) {
    const candidate = candidateByPath.get(record.path);
    if (stableJson(candidate) === stableJson(record)) continue;
    missingOrChanged += 1;
  }
  const sourcePaths = new Set(sourceRecords.map((record) => record.path));
  const extras = candidateRecords.filter((record) => !sourcePaths.has(record.path));
  const roots = [...allowedExtraRoots].map((root) => root.replace(/\/$/u, ''));
  const unexpectedExtras = extras.filter((record) => !roots.some(
    (root) => record.path === `${root}/` || record.path.startsWith(`${root}/`),
  ));
  invariant(missingOrChanged === 0,
    `${label} candidate mutated or omitted ${missingOrChanged} approved production records`);
  invariant(unexpectedExtras.length === 0,
    `${label} candidate contains ${unexpectedExtras.length} extras not attributable to fixture vaults`);
  return {
    approvedRecords: sourceRecords.length,
    approvedSha256: createHash('sha256')
      .update(`${sourceRecords.map(stableJson).join('\n')}\n`).digest('hex'),
    missingOrChanged,
    extraRecords: extras.length,
    unexpectedExtras: unexpectedExtras.length,
    extrasSha256: createHash('sha256').update(`${extras.map(stableJson).join('\n')}\n`).digest('hex'),
    derivedIndexChanges: 0,
    derivedIndexChangesSha256: createHash('sha256').update('\n').digest('hex'),
  };
}

export function validateCandidateCorpus(
  sourceCorpusRoot,
  containerMount,
  database,
  fixtureArtifact,
  { postRun: _postRun = false } = {},
) {
  const fixtureVaultRoots = relativeFixtureVaultRoots(database, fixtureArtifact, containerMount);
  const fixtureVaultIds = new Set(capacityFixtureIdentities(fixtureArtifact).map((fixture) => fixture.vaultId));
  const fixtureQmdRoots = [...fixtureVaultIds].map((vaultId) => Buffer.from(vaultId).toString('base64url'));
  const approvedQmdRoots = new Set(fs.readdirSync(path.join(path.resolve(sourceCorpusRoot), 'qmd')));
  invariant(new Set(fixtureQmdRoots).size === fixtureQmdRoots.length
    && fixtureQmdRoots.every((root) => !approvedQmdRoots.has(root)),
  'fixture QMD roots must be unique and disjoint from production roots');
  return {
    vaults: compareCorpusTree(
      path.join(path.resolve(sourceCorpusRoot), 'vaults'),
      containerMount.vaultsDirectory,
      'vault corpus',
      fixtureVaultRoots,
    ),
    qmd: compareCorpusTree(
      path.join(path.resolve(sourceCorpusRoot), 'qmd'),
      containerMount.qmdDirectory,
      'QMD corpus',
      fixtureQmdRoots,
    ),
  };
}
