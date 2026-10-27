import type { ApproveFn, ApprovalRequest } from '../electron/tools';
import { ask } from './input';
import { approvalPrompt, c, printApproval, printLine } from './term';

// CLI version of the desktop approval dialog. Every mutation / command / web
// fetch asks here. Answers: y = allow once, n = decline (the model is told),
// a = allow this kind for the rest of the session (web: per domain).
// --yes approves everything up front; a non-interactive stdin declines, so
// piped one-shot runs can never silently mutate the disk.
export function makeApprover(opts: { yes: boolean }): ApproveFn {
 const alwaysKinds = new Set<string>();
 const allowedDomains = new Set<string>();
 return async (req: ApprovalRequest): Promise<boolean> => {
  if (opts.yes) { printApproval(req); printLine('  ' + c.yellow('╰─ ') + c.dim('auto-approved (--yes)')); return true; }
  if (req.kind === 'web' && allowedDomains.has(req.target)) return true;
  if (alwaysKinds.has(req.kind)) return true;
  printApproval(req);
  if (!process.stdin.isTTY) { printLine('  ' + c.yellow('╰─ ') + c.dim('declined (non-interactive stdin — use --yes to allow)')); return false; }
  const answer = (await ask(approvalPrompt(), { approval: true })).trim().toLowerCase();
  if (answer === 'y' || answer === 'yes') return true;
  if (answer === 'a' || answer === 'always') {
   if (req.kind === 'web') allowedDomains.add(req.target); else alwaysKinds.add(req.kind);
   printLine(c.dim('  allowed for the rest of this session'));
   return true;
  }
  return false;
 };
}
