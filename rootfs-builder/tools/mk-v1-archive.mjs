#!/usr/bin/env node
// Rewrite a modern `docker save` archive into the pre-1.10 v2s1 layout that
// udocker 1.3.17's DockerLocalFileAPI understands.
//
//   node mk-v1-archive.mjs <input.tar> <output.tar> <repo:tag>
//
// Why: current skopeo only accepts oci/v2s1/v2s2 for a docker-archive
// destination, and rejects v2s1 when reading from docker-daemon
// ("need a Docker schema 2 manifest"). The daemon and buildx both emit flat
// <sha>.tar layers, which udocker's _get_saved_structure skips, so
// `udocker create` ends with "getting layers or json". This script produces
// the one layout udocker does read:
//
//   <layer-id>/VERSION   "1.0"
//   <layer-id>/json      {"id":"<id>","parent":"<parent>"}   (no parent on base)
//   <layer-id>/layer.tar
//   manifest.json        [{Config, RepoTags, Layers:[...]}]
//   repositories         {"repo":{"tag":"<top-layer-id>"}}
//
// udocker rebuilds the order by starting at whatever directory os.listdir
// returns first and following json.parent downwards, so the chain must be
// complete and parent must be absent only on the base layer.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [input, output, tag] = process.argv.slice(2);
if (!input || !output || !tag) {
  console.error('usage: mk-v1-archive.mjs <input.tar> <output.tar> <repo:tag>');
  process.exit(2);
}
const split = tag.lastIndexOf(':');
if (split < 1) {
  console.error(`tag must look like repo:tag, got ${tag}`);
  process.exit(2);
}
const repo = tag.slice(0, split);
const tagName = tag.slice(split + 1);

// GNU tar on Windows reads "C:\..." as a remote host:path, so it needs
// --force-local there; Linux ignores nothing by accepting it either way.
function runTar(args) {
  const flags = process.platform === 'win32' ? ['--force-local'] : [];
  execFileSync('tar', [...flags, ...args], { stdio: 'inherit' });
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mkv1-'));
try {
  runTar(['-xf', path.resolve(input), '-C', work]);

  const raw = JSON.parse(fs.readFileSync(path.join(work, 'manifest.json'), 'utf8'));
  const entry = Array.isArray(raw) ? raw[0] : raw;
  const rawConfig = entry.Config ?? '';
  const layers = entry.Layers ?? [];
  // Same OCI-path ambiguity as the layers: try the literal path, its basename
  // and the basename plus .json before concluding the config is absent.
  const configFile = [rawConfig, path.basename(rawConfig), `${path.basename(rawConfig)}.json`]
    .find(name => name && fs.existsSync(path.join(work, name)));
  if (!configFile) {
    throw new Error(`config ${rawConfig} missing from the archive`);
  }
  if (!layers.length) throw new Error('the archive lists no layers');

  const ids = [];
  let parent = '';
  const present = new Set(fs.readdirSync(work));
  console.log(`archive holds ${present.size} top-level entries`);
  layers.forEach((layer) => {
    // buildx with the containerd store writes manifest Layers as OCI-ish
    // "blobs/sha256/<digest>" paths while the tar itself holds flat
    // "<digest>.tar" files, so resolve by basename before giving up.
    const candidates = [layer, path.basename(layer), `${path.basename(layer)}.tar`];
    const source = candidates.map(name => path.join(work, name)).find(p => fs.existsSync(p));
    if (!source) {
      // manifest Layers can list OCI empty layers that carry no filesystem
      // content and are never written as tars. Dropping one keeps the parent
      // chain contiguous, so udocker still walks it correctly.
      console.log(`skip layer with no payload: ${layer}`);
      return;
    }
    const id = createHash('sha256').update(`${parent}:${layer}:${ids.length}`).digest('hex');
    const dir = path.join(work, id);
    fs.mkdirSync(dir, { recursive: true });
    // load_json() parses VERSION, so it has to be valid JSON.
    fs.writeFileSync(path.join(dir, 'VERSION'), '"1.0"\n');
    fs.writeFileSync(path.join(dir, 'json'), JSON.stringify(parent ? { id, parent } : { id }));
    fs.renameSync(source, path.join(dir, 'layer.tar'));
    ids.push(id);
    parent = id;
  });
  if (!ids.length) throw new Error('none of the listed layers carried any payload');

  fs.writeFileSync(path.join(work, 'manifest.json'), JSON.stringify([{
    Config: configFile,
    RepoTags: [tag],
    Layers: ids.map(id => `${id}/layer.tar`),
  }]));
  fs.writeFileSync(path.join(work, 'repositories'), JSON.stringify({ [repo]: { [tagName]: ids[ids.length - 1] } }));

  // Anything else (leftover flat layer tars, nested blobs dirs) must go, or
  // udocker sees two sources for the same data and rejects the archive.
  const keep = new Set(['manifest.json', 'repositories', configFile, ...ids]);
  for (const name of fs.readdirSync(work)) {
    if (!keep.has(name)) fs.rmSync(path.join(work, name), { recursive: true, force: true });
  }

  fs.rmSync(path.resolve(output), { force: true });
  runTar(['-cf', path.resolve(output), '-C', work, ...keep]);
  console.log(`V1_OK layers=${ids.length} tag=${tag} bytes=${fs.statSync(path.resolve(output)).size}`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}