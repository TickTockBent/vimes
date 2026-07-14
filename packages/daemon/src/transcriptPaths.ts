import { homedir } from 'node:os';
import { join } from 'node:path';

// ─── Claude Code transcript-path encoding (fragile-adapter boundary, D7) ─────
//
// Claude Code stores each project's transcripts under
// `~/.claude/projects/<encoded-cwd>/<claudeSessionId>.jsonl`. The encoded-cwd is
// the absolute cwd with the path separators folded to '-'.
//
// OBSERVED (rule 0.7) against the real ~/.claude/projects on this box, CLI
// 2.1.207: '/' → '-'; underscores are PRESERVED
// (`-home-ticktockbent-projects-games-unnamed_progress_ship_game`). This
// CONTRADICTS the step-2 brief's declared '_'→'-' rule — observed truth wins.
// '.' → '-' follows the documented Claude convention but was NOT observable here
// (no dotted project dir present); it is the one unverified edge and the reason
// this lives in a single isolated function. Everything else passes through.
export function encodeCwdForProjects(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

export function defaultProjectsRoot(): string {
  return join(homedir(), '.claude', 'projects');
}

// The directory Claude Code writes this cwd's transcripts into.
export function transcriptDirFor(projectsRoot: string, cwd: string): string {
  return join(projectsRoot, encodeCwdForProjects(cwd));
}

// The transcript file for a specific Claude session id within a cwd.
export function transcriptFileFor(projectsRoot: string, cwd: string, claudeSessionId: string): string {
  return join(transcriptDirFor(projectsRoot, cwd), `${claudeSessionId}.jsonl`);
}
