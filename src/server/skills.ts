import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const SCRIPT = /\.(py|sh|bash|js|mjs|cjs|ts|rb|php)$/;
const NAME = /^[a-z0-9-]{1,64}$/;

export interface SkillDoc {
  name: string;
  description: string;
  body: string;
  scripts: string[];
}

export function parseSkill(
  markdown: string,
  files: string[],
): SkillDoc | { error: string } {
  if (!markdown.startsWith('---\n') && !markdown.startsWith('---\r\n'))
    return { error: 'Skill is missing frontmatter.' };
  const end = markdown.indexOf('\n---', 3);
  if (end < 0) return { error: 'Skill frontmatter is not closed.' };
  const front = markdown.slice(markdown.indexOf('\n') + 1, end);
  const body = markdown.slice(end + 4).trim();
  if (Buffer.byteLength(body) > 16_000)
    return { error: 'Skill body is longer than 16,000 bytes.' };
  const name = /^name:\s*(.+)$/m.exec(front)?.[1]?.trim();
  const description = /^description:\s*(.+)$/m.exec(front)?.[1]?.trim();
  if (!name || !description || !NAME.test(name))
    return { error: 'Skill needs a short slug name and a description.' };
  return {
    name,
    description,
    body,
    scripts: files.filter((file) => SCRIPT.test(file)),
  };
}

export function loadSkills(dir: string): SkillDoc[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const skills: SkillDoc[] = [];
  for (const entry of entries) {
    const folder = join(dir, entry);
    try {
      if (!statSync(folder).isDirectory()) continue;
      const files = readdirSync(folder);
      if (!files.includes('SKILL.md')) continue;
      const parsed = parseSkill(
        readFileSync(join(folder, 'SKILL.md'), 'utf8'),
        files,
      );
      if ('error' in parsed || parsed.name !== entry) continue;
      try {
        const nested = readdirSync(join(folder, 'scripts')).filter((file) =>
          SCRIPT.test(file),
        );
        parsed.scripts.push(...nested.map((file) => `scripts/${file}`));
      } catch {
        // A skill does not have to include scripts.
      }
      skills.push(parsed);
    } catch {
      continue;
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function skillCatalog(skills: SkillDoc[]) {
  return skills
    .slice(0, 32)
    .map(
      (skill) =>
        `${skill.name}: ${skill.description.replace(/\s+/g, ' ').slice(0, 200)}`,
    )
    .join('\n');
}

export function mentionedSkills(text: string, names: string[]) {
  return names.filter((name) =>
    new RegExp(`(^|\\s)@${name}(?![a-z0-9-])`).test(text),
  );
}

export function isSkillName(name: string) {
  return NAME.test(name);
}

export function readSkillMarkdown(dir: string, name: string) {
  if (!NAME.test(name)) return undefined;
  try {
    return readFileSync(join(dir, name, 'SKILL.md'), 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Writes a skill's SKILL.md into its own folder. A new skill must not reuse a
 * name; an edit must keep its name.
 */
export function saveSkill(
  dir: string,
  markdown: string,
  options: { replace?: string } = {},
): SkillDoc {
  const text = markdown.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const parsed = parseSkill(text, []);
  if ('error' in parsed) throw new Error(parsed.error);
  const folder = join(dir, parsed.name);
  if (options.replace != null && options.replace !== parsed.name)
    throw new Error('Keep the skill name when editing it.');
  if (options.replace == null && existsSync(folder))
    throw new Error(`A skill named ${parsed.name} already exists.`);
  if (options.replace != null && !existsSync(join(folder, 'SKILL.md')))
    throw new Error('Skill not found.');
  mkdirSync(folder, { recursive: true });
  const temporary = join(folder, `.SKILL.md.${process.pid}.tmp`);
  writeFileSync(temporary, text);
  renameSync(temporary, join(folder, 'SKILL.md'));
  return parsed;
}

export function deleteSkill(dir: string, name: string) {
  if (!NAME.test(name) || !existsSync(join(dir, name, 'SKILL.md')))
    return false;
  rmSync(join(dir, name), { recursive: true, force: true });
  return true;
}

/** Skill markdown is data. Scripts are named and never run. */
export function skillInstructions(doc: SkillDoc) {
  return {
    name: doc.name,
    instructions: doc.body,
    scripts: doc.scripts,
    executed: false as const,
    note: doc.scripts.length
      ? 'Scripts are listed for the owner and are never executed.'
      : 'This skill has no scripts.',
  };
}
