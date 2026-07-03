import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const DependencyMapSchema = z.record(z.string(), z.string());

const ManifestSchema = z.object({
  dependencies: DependencyMapSchema.optional(),
  devDependencies: DependencyMapSchema.optional(),
  optionalDependencies: DependencyMapSchema.optional(),
  peerDependencies: DependencyMapSchema.optional(),
});

const PackageListSchema = z.object({ packages: z.array(z.string()) });
const WorkspaceSchema = z.object({ workspaces: PackageListSchema });

const dependencyKeys = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

const WORKSPACE_GLOB_SUFFIX = '/*';

const readManifest = <S extends z.ZodType>(manifestPath: string, schema: S) =>
  schema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));

const expandPattern = (pattern: string) => {
  if (!pattern.endsWith(WORKSPACE_GLOB_SUFFIX)) return [pattern];
  const parent = pattern.slice(0, -WORKSPACE_GLOB_SUFFIX.length);
  const parentPath = path.join(repoRoot, parent);
  if (!existsSync(parentPath)) return [];
  return readdirSync(parentPath, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(parent, entry.name));
};

const listManifestPaths = () => {
  const { workspaces } = readManifest(path.join(repoRoot, 'package.json'), WorkspaceSchema);
  const relativePaths = ['.', ...workspaces.packages.flatMap(pattern => expandPattern(pattern))];
  return relativePaths.map(relativePath => path.join(repoRoot, relativePath, 'package.json'));
};

type Manifest = z.infer<typeof ManifestSchema>;

const collectManifestOffenders = (label: string, manifest: Manifest) =>
  dependencyKeys.flatMap(key =>
    Object.entries(manifest[key] ?? {})
      .filter(([, spec]) => !spec.startsWith('catalog:') && !spec.startsWith('workspace:'))
      .map(([name, spec]) => `${label} → ${key}.${name} = "${spec}"`),
  );

const findOffenders = () =>
  listManifestPaths().flatMap(manifestPath =>
    collectManifestOffenders(path.relative(repoRoot, manifestPath), readManifest(manifestPath, ManifestSchema)),
  );

describe('workspace dependency discipline', () => {
  it('every dependency entry in a workspace package.json uses catalog: or workspace:', () => {
    expect(findOffenders()).toEqual([]);
  });
});
