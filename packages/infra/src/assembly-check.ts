import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

interface Template {
  Resources?: Record<string, { Type: string; Properties?: Record<string, unknown> }>;
}

/**
 * The deploy job's gate for staging (see the spec's "Staging deploys without AWS credentials"):
 * the cloud assembly built from a branch may contain only the one expected app stack, and it may
 * not create IAM users, access keys or policies outside the staging rules. Returns the problems
 * found (empty = OK to deploy).
 */
export function checkAssembly(assemblyDir: string, expectedStack: string): string[] {
  const problems: string[] = [];
  const manifest = JSON.parse(readFileSync(path.join(assemblyDir, 'manifest.json'), 'utf8')) as {
    artifacts?: Record<string, { type: string; properties?: { templateFile?: string; stackName?: string } }>;
  };
  const stacks = Object.entries(manifest.artifacts ?? {}).filter(([, a]) => a.type === 'aws:cloudformation:stack');
  const names = stacks.map(([id, a]) => a.properties?.stackName ?? id);
  if (names.length !== 1 || names[0] !== expectedStack) {
    problems.push(`assembly must contain exactly the stack ${expectedStack}, found: ${names.join(', ') || 'none'}`);
  }
  const forbiddenTypes = new Set(['AWS::IAM::User', 'AWS::IAM::AccessKey', 'AWS::IAM::Group', 'AWS::IAM::ManagedPolicy', 'AWS::IAM::OIDCProvider', 'AWS::IAM::SAMLProvider']);
  for (const [id, artifact] of stacks) {
    const file = artifact.properties?.templateFile;
    if (!file) continue;
    const template = JSON.parse(readFileSync(path.join(assemblyDir, file), 'utf8')) as Template;
    for (const [logicalId, res] of Object.entries(template.Resources ?? {})) {
      if (forbiddenTypes.has(res.Type)) problems.push(`${id}/${logicalId}: ${res.Type} is not allowed in app stacks`);
      if (res.Type === 'AWS::IAM::Role' && !res.Properties?.PermissionsBoundary) {
        problems.push(`${id}/${logicalId}: IAM role without the staging permissions boundary`);
      }
    }
  }
  // Assets: the deploy job publishes them next to AWS credentials, so nothing in the assembly may
  // make it run a command of the branch's choosing. Files are plain uploads; the only image allowed
  // is a tarball inside the assembly, loaded with exactly the command CDK writes for one.
  for (const name of readdirSync(assemblyDir).filter((f) => f.endsWith('.assets.json'))) {
    const assets = JSON.parse(readFileSync(path.join(assemblyDir, name), 'utf8')) as {
      files?: Record<string, { source?: { executable?: unknown } }>;
      dockerImages?: Record<string, { source?: { directory?: string; executable?: unknown } }>;
    };
    for (const [id, file] of Object.entries(assets.files ?? {})) {
      if (file.source?.executable) problems.push(`${name}/${id}: file assets may not run a command`);
    }
    for (const [id, image] of Object.entries(assets.dockerImages ?? {})) {
      const problem = imageProblem(assemblyDir, image.source);
      if (problem) problems.push(`${name}/${id}: ${problem}`);
    }
  }
  // Nested assemblies (stages) could hide more stacks.
  if (readdirSync(assemblyDir).some((f) => f.startsWith('assembly-'))) problems.push('nested assemblies are not allowed');
  return problems;
}

/** The script CDK writes for `ContainerImage.fromTarball`: load the tarball given as `$1`, print the image's name. */
const TARBALL_LOAD = 'docker load -i "$1" | tail -n 1 | sed "s/Loaded image[^:]*: //g"';
const TARBALL_NAME = /^asset\.[0-9a-f]{64}\.tar$/;

function imageProblem(assemblyDir: string, source: { directory?: string; executable?: unknown } | undefined): string | null {
  if (!source) return 'image asset without a source';
  if (source.directory !== undefined) return 'images are built in the build job and deployed as tarballs, never built from a directory at deploy time';
  const exec = source.executable;
  const expected = Array.isArray(exec) && exec.length === 5 && exec[0] === 'sh' && exec[1] === '-c' && exec[2] === TARBALL_LOAD && exec[3] === 'cdk-tarball-image-asset';
  const file: unknown = expected ? (exec as unknown[])[4] : undefined;
  if (typeof file !== 'string' || !TARBALL_NAME.test(file)) return 'image asset with an unexpected load command';
  const tarball = path.join(assemblyDir, file);
  if (!existsSync(tarball)) return `image tarball ${file} is not in the assembly`;
  // The placeholder a synth without Docker writes is a line of text, not an image.
  if (statSync(tarball).size < 1024 * 1024) return `image tarball ${file} is not a built image (was the game image built before synth?)`;
  return null;
}
