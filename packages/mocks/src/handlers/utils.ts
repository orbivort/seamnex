import type { Capability, FieldError, PlatformRole } from '@seamnex/domain';
import { accessFor } from '@seamnex/domain';
import { HttpResponse } from 'msw';
import { appendAudit, type AuditActor } from '../store';

/** Actor identity behind each demo role, so audit records name a person, not a header. */
export const ACTOR_BY_ROLE: Record<PlatformRole, AuditActor> = {
  R1: { id: 'usr-sofia', name: 'Sofia Almeida', type: 'user' },
  R2: { id: 'usr-ruth-adler', name: 'Ruth Adler', type: 'user' },
  R3: { id: 'usr-mara-vogel', name: 'Mara Vogel', type: 'user' },
  R4: { id: 'usr-tomas-reiter', name: 'Tomas Reiter', type: 'user' },
  R5: { id: 'usr-lena-hoff', name: 'Lena Hoff', type: 'user' },
  R6: { id: 'usr-jonas-weber', name: 'Jonas Weber', type: 'user' },
};

export function actorFor(role: PlatformRole): AuditActor {
  return ACTOR_BY_ROLE[role];
}

export function problem(
  status: number,
  code: string,
  title: string,
  detail: string,
  remediation: string,
  fieldErrors: FieldError[] = [],
) {
  return HttpResponse.json(
    {
      type: `https://platform.seamnex.local/problems/${code.toLowerCase()}`,
      title,
      status,
      detail,
      code,
      fieldErrors,
      remediation,
    },
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

export function roleOf(request: Request): PlatformRole {
  const header = request.headers.get('x-seamnex-role');
  if (
    header === 'R1' ||
    header === 'R2' ||
    header === 'R3' ||
    header === 'R4' ||
    header === 'R5' ||
    header === 'R6'
  ) {
    return header;
  }
  return 'R5';
}

/** Deny-by-default guard driven by the §5.2 capability matrix. */
export function requireCapability(role: PlatformRole, capability: Capability) {
  if (accessFor(role, capability) !== 'none') return null;
  appendAudit({
    action: 'access.denied',
    targetType: 'capability',
    targetId: capability,
    targetLabel: `${capability} · ${role}`,
    outcome: 'denied',
    detail: `${role} requested ${capability} without a grant; deny-by-default policy applied.`,
    actor: actorFor(role),
  });
  return problem(
    403,
    'FORBIDDEN',
    `${capability} is not permitted for ${role}`,
    'The platform evaluates every request against the capability matrix with deny-by-default.',
    'Sign in with a role that holds this capability, or request access from the domain owner.',
  );
}

export function requireAnyCapability(role: PlatformRole, capabilities: Capability[]) {
  if (capabilities.some((capability) => accessFor(role, capability) !== 'none')) return null;
  return requireCapability(role, capabilities[0] ?? 'portal.sign_in');
}

/** Deny-by-default guard for mutating handlers. */
export function deny(role: PlatformRole, allowed: PlatformRole[], capability: string) {
  if (allowed.includes(role)) return null;
  appendAudit({
    action: 'access.denied',
    targetType: 'capability',
    targetId: capability,
    targetLabel: `${capability} · ${role}`,
    outcome: 'denied',
    detail: `${role} attempted ${capability}; permitted roles are ${allowed.join(', ')}.`,
    actor: actorFor(role),
  });
  return problem(
    403,
    'FORBIDDEN',
    `${capability} is not permitted for ${role}`,
    'The platform evaluates every request against the capability matrix with deny-by-default.',
    'Sign in with a role that holds this capability, or request access from the domain owner.',
  );
}

export function paginate<T>(
  items: T[],
  request: Request,
): { items: T[]; nextCursor: string | null; total: number } {
  const url = new URL(request.url);
  const limit = Math.min(
    Math.max(Number.parseInt(url.searchParams.get('limit') ?? '100', 10) || 100, 1),
    100,
  );
  const start = Math.max(Number.parseInt(url.searchParams.get('cursor') ?? '0', 10) || 0, 0);
  const page = items.slice(start, start + limit);
  const next = start + page.length;
  return {
    items: page,
    nextCursor: next < items.length ? String(next) : null,
    total: items.length,
  };
}

export function readBody<T>(request: Request): Promise<T> {
  return request.json() as Promise<T>;
}

/** Content-derived validator, so an ETag changes exactly when the representation changes. */
export function etagFor(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `"${hash.toString(16).padStart(8, '0')}"`;
}
