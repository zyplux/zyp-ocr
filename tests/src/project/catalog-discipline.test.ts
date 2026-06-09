import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const dependencyMap = z.record(z.string(), z.string());

const manifestSchema = z.object({
  dependencies: dependencyMap.optional(),
  devDependencies: dependencyMap.optional(),
  optionalDependencies: dependencyMap.optional(),
  peerDependencies: dependencyMap.optional(),
});

const workspaceSchema = z.object({
  workspaces: z.object({ packages: z.array(z.string()) }),
});

const dependencyKeys = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

const readManifest = (manifestPath: string) => {
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return parsed;
};

const expandPattern = (pattern: string) => {
  if (!pattern.endsWith('/*')) return [pattern];
  const parent = pattern.slice(0, -2);
  const parentPath = path.join(repoRoot, parent);
  if (!existsSync(parentPath)) return [];
  return readdirSync(parentPath, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(parent, entry.name));
};

const listManifestPaths = () => {
  const { workspaces } = workspaceSchema.parse(readManifest(path.join(repoRoot, 'package.json')));
  const relativePaths = ['.', ...workspaces.packages.flatMap(pattern => expandPattern(pattern))];
  return relativePaths.map(relativePath => path.join(repoRoot, relativePath, 'package.json'));
};

const findOffenders = () => {
  const offenders: string[] = [];
  for (const manifestPath of listManifestPaths()) {
    const manifest = manifestSchema.parse(readManifest(manifestPath));
    const label = path.relative(repoRoot, manifestPath);
    for (const key of dependencyKeys) {
      const deps = manifest[key];
      if (!deps) continue;
      for (const [name, spec] of Object.entries(deps)) {
        if (!spec.startsWith('catalog:') && !spec.startsWith('workspace:')) {
          offenders.push(`${label} → ${key}.${name} = "${spec}"`);
        }
      }
    }
  }
  return offenders;
};

describe('workspace dependency discipline', () => {
  it('every dependency entry in a workspace package.json uses catalog: or workspace:', () => {
    expect(findOffenders()).toEqual([]);
  });
});
