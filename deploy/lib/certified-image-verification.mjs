// Image verification primitives: inspect local image metadata and manifest checksum sidecars.
// Inputs are image tags, manifests, and checkout revisions; outputs are identity checks; failures throw.
// Ordering verifies bytes/checksum and checkout before trusting runtime image labels.

import * as p from './certified-primitives.mjs';
const { commandOutput, invariant, artifactSnapshot } = p;

export function inspectImage(image) {
  const [inspection] = JSON.parse(commandOutput('docker', ['image', 'inspect', image]));
  invariant(inspection, `image ${image} is unavailable`);
  return inspection;
}

export function runtimeImageId(inspection) {
  const id = inspection.Descriptor?.annotations?.['config.digest'] || inspection.Id;
  invariant(/^sha256:[0-9a-f]{64}$/u.test(id || ''), 'image has no canonical runtime config ID');
  return id;
}

export function verifyImage(manifest) {
  const inspection = inspectImage(manifest.image.tag);
  const localImageId = runtimeImageId(inspection);
  invariant(localImageId === manifest.image.id,
    `local image ${manifest.image.tag} is ${localImageId}, expected ${manifest.image.id}`);
  invariant(inspection.Config?.Labels?.['org.opencontainers.image.revision'] === manifest.revision,
    'image revision label does not match the certification manifest');
  invariant(inspection.Config?.Labels?.['io.cascade.backend'] === 'elixir', 'image is not labeled as the Elixir backend');
}

export function verifyChecksum(manifestPath, actual = null) {
  const sidecar = artifactSnapshot(`${manifestPath}.sha256`, 'manifest checksum sidecar');
  const expected = sidecar.text.trim().split(/\s+/u)[0];
  invariant(/^[0-9a-f]{64}$/.test(expected), 'manifest checksum sidecar is invalid');
  invariant((actual || artifactSnapshot(manifestPath, 'certification manifest').sha256) === expected,
    'certification manifest checksum does not match');
}

export function requireExactCheckout(revision, clean) {
  invariant(commandOutput('git', ['rev-parse', 'HEAD']) === revision, 'manifest revision is not the checked-out commit');
  if (clean) invariant(commandOutput('git', ['status', '--porcelain', '--untracked-files=all']) === '',
    'certification requires a clean checkout');
}
