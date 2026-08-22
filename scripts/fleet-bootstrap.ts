/** Fleet bootstrap CLI: projects the host OMP model config into the
 * operator-owned fleet catalog. Create-if-missing by default; merges
 * missing ids when a catalog already exists. Never touches credentials. */

import { readFileSync } from 'node:fs';

import { bootstrapCatalog, defaultModelsYamlPath, fleetCatalogPath, loadCatalogFile, mergeCatalog, parseOmpModelsYaml, saveCatalogFile } from '../src/fleet-catalog.js';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const modelsPath = flag('--models') ?? defaultModelsYamlPath();
const entries = parseOmpModelsYaml(readFileSync(modelsPath, 'utf8'));
if (entries.length === 0) {
  console.error(`fleet-bootstrap: no providers found in ${modelsPath}`);
  process.exit(1);
}
const catalogPath = fleetCatalogPath();
const merged = mergeCatalog(loadCatalogFile(catalogPath), bootstrapCatalog(entries));
saveCatalogFile(catalogPath, merged);
console.log(`fleet catalog at ${catalogPath}: added ${merged.added.length} provider(s)${merged.added.length > 0 ? ` (${merged.added.join(', ')})` : ''}; total ${merged.providers.length}.`);
